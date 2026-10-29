import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorityOf, nameToFill, noAuthority, normalizeDotNumber, normalizeMcNumber, parseFmcsaCarrier, type AuthorityResult } from "@/lib/fmcsa";
import { clearFmcsaMemory, lookupMc } from "@/server/fmcsa/lookup";

const documentedObjectWrapper = {
  content: {
    carrier: {
      legalName: "ACME LOGISTICS LLC",
      dbaName: "ACME",
      dotNumber: 1234567,
      mcNumber: 123456,
      allowedToOperate: "Y",
      brokerAuthorityStatus: "A",
      commonAuthorityStatus: "N",
      phyCity: "DALLAS",
      phyState: "TX"
    }
  }
};

const documentedArrayWrapper = {
  content: [{ carrier: { legalName: "ACME LOGISTICS LLC", dbaName: "ACME", dotNumber: 1234567, mcNumber: 123456, allowToOperate: "Y", phyCity: "DALLAS", phyState: "TX" } }]
};

const ok = (body: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

describe("the FMCSA readers (ported from the phone, same cases)", () => {
  it("normalizes DOT and MC inputs", () => {
    expect(normalizeDotNumber("USDOT 1,234,567")).toBe("1234567");
    expect(normalizeDotNumber("abc")).toBeNull();
    expect(normalizeMcNumber("MC-123456")).toBe("123456");
    expect(normalizeMcNumber("mx 99")).toBe("99");
    expect(normalizeMcNumber("not-an-mc")).toBeNull();
  });

  it("parses the documented content.carrier object wrapper", () => {
    expect(parseFmcsaCarrier(documentedObjectWrapper)).toEqual({
      legalName: "ACME LOGISTICS LLC",
      dbaName: "ACME",
      dotNumber: "1234567",
      mcNumber: "123456",
      allowedToOperate: "Y",
      brokerAuthorityStatus: "A",
      commonAuthorityStatus: "N",
      phyCity: "DALLAS",
      phyState: "TX"
    });
  });

  it("parses content as an array of { carrier } (the multi-result shape) and reads allowToOperate", () => {
    const carrier = parseFmcsaCarrier(documentedArrayWrapper);
    expect(carrier?.legalName).toBe("ACME LOGISTICS LLC");
    expect(carrier?.allowedToOperate).toBe("Y");
  });

  it("is null on empty or unusable content", () => {
    expect(parseFmcsaCarrier({ content: [] })).toBeNull();
    expect(parseFmcsaCarrier(null)).toBeNull();
    expect(parseFmcsaCarrier({ content: { carrier: {} } })).toBeNull();
  });
});

describe("what the desk shows for a carrier", () => {
  const carrier = (over: Record<string, unknown>) => parseFmcsaCarrier({ content: { carrier: { legalName: "ACME LOGISTICS LLC", mcNumber: 123456, allowedToOperate: "Y", phyCity: "FORT WORTH", phyState: "TX", ...over } } })!;

  it("reads broker authority, carrier-only authority, and neither", () => {
    expect(authorityOf(carrier({ brokerAuthorityStatus: "A", commonAuthorityStatus: "N" }))).toEqual({ state: "broker", label: "Broker authority active", name: "ACME LOGISTICS LLC", place: "Fort Worth, TX" });
    expect(authorityOf(carrier({ brokerAuthorityStatus: "N", commonAuthorityStatus: "A" })).state).toBe("carrier");
    expect(authorityOf(carrier({ brokerAuthorityStatus: "I", commonAuthorityStatus: "I" })).state).toBe("inactive");
  });

  it("calls a carrier that is not allowed to operate inactive even with authority on file", () => {
    expect(authorityOf(carrier({ brokerAuthorityStatus: "A", allowedToOperate: "N" })).state).toBe("inactive");
  });

  it("uses the trade name when there is no legal name", () => {
    expect(authorityOf(carrier({ legalName: null, dbaName: "ACME", brokerAuthorityStatus: "A" })).name).toBe("ACME");
  });

  it("fills the customer name only when the box is empty", () => {
    const found: AuthorityResult = { state: "broker", label: "x", name: "ACME LOGISTICS LLC", place: null };
    expect(nameToFill("", found)).toBe("ACME LOGISTICS LLC");
    expect(nameToFill("   ", found)).toBe("ACME LOGISTICS LLC");
    expect(nameToFill(null, found)).toBe("ACME LOGISTICS LLC");
    expect(nameToFill("Acme (our usual)", found)).toBeNull(); // a typed name is never replaced
    expect(nameToFill("", noAuthority("not_found"))).toBeNull(); // nothing found, nothing to fill
  });
});

describe("the FMCSA lookup", () => {
  beforeEach(() => clearFmcsaMemory());

  it("calls the documented docket-number path with the key as webKey, and reads the answer", async () => {
    const fetchImpl = ok(documentedObjectWrapper);
    const out = await lookupMc("MC-123456", fetchImpl, "test-web-key");
    expect(out).toMatchObject({ state: "broker", name: "ACME LOGISTICS LLC", place: "Dallas, TX" });
    expect(fetchImpl).toHaveBeenCalledWith("https://mobile.fmcsa.dot.gov/qc/services/carriers/docket-number/123456?webKey=test-web-key", expect.objectContaining({ headers: { Accept: "application/json" } }));
  });

  it("says not found for an empty answer, and unavailable for a throw, a 429, a 500 or a missing key, and asks nothing without a key", async () => {
    expect((await lookupMc("111111", ok({ content: [] }), "k")).state).toBe("not_found");
    const thrown = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await lookupMc("222222", thrown, "k")).state).toBe("unavailable");
    const status = (code: number) => vi.fn(async () => ({ ok: false, status: code, json: async () => ({}) })) as unknown as typeof fetch;
    expect((await lookupMc("333333", status(429), "k")).state).toBe("unavailable");
    expect((await lookupMc("444444", status(500), "k")).state).toBe("unavailable");
    const never = vi.fn() as unknown as typeof fetch;
    expect((await lookupMc("555555", never, "")).state).toBe("unavailable");
    expect(never).not.toHaveBeenCalled();
  });

  it("is not a lookup at all for something that is not an MC", async () => {
    const never = vi.fn() as unknown as typeof fetch;
    expect((await lookupMc("not-an-mc", never, "k")).state).toBe("not_found");
    expect((await lookupMc("123456789012", never, "k")).state).toBe("not_found"); // more digits than any MC
    expect(never).not.toHaveBeenCalled();
  });

  it("remembers an answer, but not a failure, so an outage clears itself", async () => {
    const fetchImpl = ok(documentedObjectWrapper);
    await lookupMc("666666", fetchImpl, "k");
    await lookupMc("MC 666666", fetchImpl, "k");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const flaky = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true, status: 200, json: async () => documentedObjectWrapper }) as unknown as typeof fetch;
    expect((await lookupMc("777777", flaky, "k")).state).toBe("unavailable");
    expect((await lookupMc("777777", flaky, "k")).state).toBe("broker");
  });
});
