import { describe, expect, it } from "vitest";
import { lumperFlag, type LumperInput } from "@/lib/lumper";

const base = (over: Partial<LumperInput> = {}): LumperInput => ({
  commodity: null,
  text: [],
  stops: [
    { stopType: "pickup", facilityName: "Acme Steel" },
    { stopType: "delivery", facilityName: "Lone Star Fabrication" }
  ],
  ...over
});

describe("lumperFlag", () => {
  it("a stated lumper is stated, wherever it is printed", () => {
    expect(lumperFlag(base({ text: ["Lumper paid by receiver, receipt required."] }))?.kind).toBe("stated");
    expect(lumperFlag(base({ text: ["", "Lumper reimbursement"] }))?.kind).toBe("stated");
  });

  it.each(["Fresh produce", "Groceries", "Frozen foods", "Dairy, 40 pallets"])("commodity %s is a likely lumper", (commodity) => {
    expect(lumperFlag(base({ commodity }))).toMatchObject({ kind: "likely" });
  });

  it.each(["Kroger DC #412", "Sysco Dallas", "Tyson Foods", "Fresh Produce Terminal"])("receiver %s is a likely lumper", (name) => {
    const f = lumperFlag(base({ stops: [{ stopType: "pickup", facilityName: "Acme" }, { stopType: "delivery", facilityName: name }] }));
    expect(f?.kind).toBe("likely");
    expect(f?.text).toContain(`receiver ${name}`);
  });

  it("a grocer at the pickup is named as the shipper", () => {
    const f = lumperFlag(base({ stops: [{ stopType: "pickup", facilityName: "Albertsons DC" }, { stopType: "delivery", facilityName: "Acme" }] }));
    expect(f?.text).toContain("shipper Albertsons DC");
  });

  it("said outright beats guessed", () => {
    expect(lumperFlag(base({ commodity: "Produce", text: ["Lumper at receiver"] }))?.kind).toBe("stated");
  });

  it("a negation and ordinary freight raise nothing", () => {
    expect(lumperFlag(base({ text: ["No lumper required."] }))).toBeNull();
    expect(lumperFlag(base({ text: ["Lumper not needed"] }))).toBeNull();
    expect(lumperFlag(base({ commodity: "Steel coils" }))).toBeNull();
    expect(lumperFlag(base({ stops: [], commodity: null }))).toBeNull();
  });
});
