import { inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { ACCOUNT_KEYS } from "@/lib/accounting-map";
import { CLAIM_ACK_DAYS, CLAIM_DECIDE_DAYS, claimDeadlines, validateClaimCreate, validateClaimUpdate } from "@/lib/claims";
import { AUTO_TO_DRIVER, DOC_LABEL, isDocKind } from "@/lib/documents";
import { lineKindOf } from "@/lib/invoice-records";
import { buildInvoicePdf } from "@/lib/invoice-pdf";
import { parseBilledExtras, SUPPLEMENTAL_KINDS, unbilledExtrasOf, validateInvoice } from "@/lib/invoicing";
import { planStopChanges, toEditValues, validateLoadEdit, type ExistingStopPlan, type LoadEditValues } from "@/lib/load-edit";
import { BLANK_QUOTE, reverseStops, validateQuote } from "@/lib/quote";
import { ROAD_ROUTE_NOTE } from "@/lib/telematics";

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const flate = obj.dict.get(PDFName.of("Filter"));
      const raw = Buffer.from(obj.contents);
      const buf = flate?.toString() === "/FlateDecode" ? inflateSync(raw) : raw;
      const chunk = buf.toString("latin1");
      out += `\n${chunk}`;
      for (const m of chunk.matchAll(/<([0-9A-Fa-f]{2,})>/g)) {
        const hex = m[1]!;
        if (hex.length % 2 === 0) out += `\n${Buffer.from(hex, "hex").toString("latin1")}`;
      }
    }
  }
  return out;
}

describe("Phase 6 pure logic and safety invariants", () => {
  test("planStopChanges locks visited stops and sequences while allowing unvisited stop add/edit/reorder/drop", () => {
    const t0 = new Date("2027-02-01T14:00:00Z");
    const t1 = new Date("2027-02-01T20:00:00Z");
    const t2 = new Date("2027-02-02T14:00:00Z");
    const existing: ExistingStopPlan[] = [
      { id: "s1", stopSequence: 1, role: "pickup", address: "Dallas, TX", earliest: t0, latest: t1, visited: true },
      { id: "s2", stopSequence: 2, role: "delivery", address: "Oklahoma City, OK", earliest: t2, latest: null, visited: false },
      { id: "s3", stopSequence: 3, role: "delivery", address: "Tulsa, OK", earliest: t2, latest: null, visited: false }
    ];

    // Modifying a visited stop's address or time is rejected.
    expect(
      planStopChanges(existing, [
        { id: "s1", role: "pickup", address: "Fort Worth, TX", earliest: t0, latest: t1 },
        { id: "s2", role: "delivery", address: "Oklahoma City, OK", earliest: t2, latest: null }
      ])
    ).toMatchObject({ ok: false, error: expect.stringContaining("visited stops") });

    // Reordering visited stop past an unvisited stop is rejected (wrong id at index 0).
    expect(
      planStopChanges(existing, [
        { id: "s2", role: "delivery", address: "Oklahoma City, OK", earliest: t2, latest: null },
        { id: "s1", role: "pickup", address: "Dallas, TX", earliest: t0, latest: t1 }
      ])
    ).toMatchObject({ ok: false, error: expect.stringContaining("visited stops") });

    // Dropping below 2 stops fails.
    expect(
      planStopChanges(existing, [{ id: "s1", role: "pickup", address: "Dallas, TX", earliest: t0, latest: t1 }])
    ).toMatchObject({ ok: false, error: expect.stringContaining("changed since you opened it") });

    // Reordering unvisited s3 ahead of s2 + adding new:stop2 preserves visited sequence 1 cleanly.
    const planned = planStopChanges(existing, [
      { id: "s1", role: "pickup", address: "Dallas, TX", earliest: t0, latest: t1 },
      { id: "s3", role: "delivery", address: "Tulsa, OK", earliest: t2, latest: null },
      { id: "new:extra", role: "delivery", address: "Kansas City, MO", earliest: new Date("2027-02-03T14:00:00Z"), latest: null }
    ]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.removedIds).toEqual(["s2"]);
    expect(planned.structureChanged).toBe(true);
    expect(planned.routeChanged).toBe(true);
    expect(planned.scheduleChanged).toBe(true);
    expect(planned.planned.map((p) => ({ id: p.id, seq: p.stopSequence, isNew: p.isNew, visited: p.visited }))).toEqual([
      { id: "s1", seq: 1, isNew: false, visited: true },
      { id: "s3", seq: 2, isNew: false, visited: false },
      { id: "new:extra", seq: 3, isNew: true, visited: false }
    ]);
  });

  test("validateLoadEdit accepts reference numbers, freight specs, reefer, hazmat, and mid-trip change reason/fee", () => {
    const base: LoadEditValues = {
      ...toEditValues({
        brokerName: "Apex Brokerage",
        brokerMcNumber: "123456",
        brokerPhone: "555-0100",
        brokerEmail: "ap@apex.test",
        loadNumber: "TMS-100",
        rateConNumber: "RC-900",
        proNumber: "PRO-77",
        poNumber: "PO-55",
        bolNumber: "BOL-12",
        trailerType: "reefer",
        commodity: "Fresh produce",
        pieceCount: 400,
        palletCount: 22,
        weightLbs: 38000,
        lengthFt: 53,
        widthFt: null,
        loadHeightIn: null,
        reeferSetTempF: 34,
        reeferMinF: 32,
        reeferMaxF: 36,
        reeferMode: "continuous",
        hazmatClass: "3",
        hazmatUnNumber: "UN1203",
        hazmatPackingGroup: "II",
        hazmatEmergencyPhone: "800-424-9300",
        requiresLiftgate: false,
        requiresRamp: false,
        requiresPalletJack: false,
        payTermsDays: 30,
        quotedRevenue: 1500,
        notes: "Keep sealed",
        stops: [
          { id: "s1", stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", facilityName: "Cold Dock", timeWindowEarliest: new Date("2027-02-01T14:00:00Z"), timeWindowLatest: null, referenceNumbers: [], contactName: null, contactPhone: null, stopNotes: null, arrivedAt: new Date("2027-02-01T14:15:00Z") },
          { id: "s2", stopType: "delivery", stopRole: "delivery", addressString: "Atlanta, GA", facilityName: "Market", timeWindowEarliest: new Date("2027-02-03T14:00:00Z"), timeWindowLatest: null, referenceNumbers: [], contactName: null, contactPhone: null, stopNotes: null, arrivedAt: null }
        ]
      }),
      stopChangeReason: "reconsignment",
      stopChangeFee: "150"
    };

    const ok = validateLoadEdit(base);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value).toMatchObject({
      loadNumber: "TMS-100",
      rateConNumber: "RC-900",
      proNumber: "PRO-77",
      bolNumber: "BOL-12",
      commodity: "Fresh produce",
      pieceCount: 400,
      palletCount: 22,
      reeferSetTempF: 34,
      reeferMinF: 32,
      reeferMaxF: 36,
      reeferMode: "continuous",
      hazmat: "3",
      hazmatUnNumber: "UN1203",
      hazmatPackingGroup: "II",
      hazmatEmergencyPhone: "800-424-9300",
      stopChangeReason: "reconsignment",
      stopChangeFee: 150
    });
    expect("visited" in ok.value.stops[0]!).toBe(false); // visited is a UI indicator on EditStopValues

    const bad = validateLoadEdit({ ...base, reeferMinF: "40", reeferMaxF: "32", hazmatPackingGroup: "IV", stopChangeReason: "bogus" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.reeferMaxF).toBeTruthy();
    expect(bad.errors.hazmatPackingGroup).toBeTruthy();
    expect(bad.errors.stopChangeReason).toBeTruthy();
  });

  test("OS&D claims compute exact 49 CFR Part 370 +30d/+120d statutory deadlines and validate inputs", () => {
    const opened = new Date("2027-03-01T12:00:00Z");
    const { ackBy, decideBy } = claimDeadlines(opened);
    expect((ackBy.getTime() - opened.getTime()) / 86_400_000).toBe(CLAIM_ACK_DAYS);
    expect((decideBy.getTime() - opened.getTime()) / 86_400_000).toBe(CLAIM_DECIDE_DAYS);

    expect(validateClaimCreate({ type: "damage", pieces: "3", amount: "425.50", openedAt: "2027-03-01" })).toMatchObject({
      ok: true,
      value: { type: "damage", pieces: 3, amount: 425.5 }
    });
    expect(validateClaimCreate({ type: "wrong" })).toMatchObject({ ok: false });
    expect(validateClaimUpdate({ status: "settled", amount: "200" })).toMatchObject({ ok: true, value: { status: "settled", amount: 200 } });
    expect(validateClaimUpdate({ status: "nope" })).toMatchObject({ ok: false });
  });

  test("osd_photo document kind is excluded from AUTO_TO_DRIVER", () => {
    expect(isDocKind("osd_photo")).toBe(true);
    expect(DOC_LABEL.osd_photo).toBe("OS&D photo");
    expect(AUTO_TO_DRIVER.includes("osd_photo" as never)).toBe(false);
    expect([...AUTO_TO_DRIVER]).toEqual(["bol", "instructions", "lumper"]);
  });

  test("quote preserves stop details, commodity, rateConNumber, proNumber across reverseStops and validateQuote", () => {
    const stops = reverseStops([
      { role: "pickup", address: "Dallas, TX", appointment: "", facility: "Dock A", contactName: "Sam", contactPhone: "555-0111", notes: "Guard shack" },
      { role: "delivery", address: "Tulsa, OK", appointment: "", facility: "Dock B", contactName: "Pat", contactPhone: "555-0222", notes: "Lumper req" }
    ]);
    expect(stops[0]).toMatchObject({ role: "pickup", address: "Tulsa, OK", facility: "Dock B", contactName: "Pat" });
    expect(stops[1]).toMatchObject({ role: "delivery", address: "Dallas, TX", facility: "Dock A", contactName: "Sam" });

    const q = validateQuote({
      ...BLANK_QUOTE,
      offer: "1800",
      loadedMiles: "400",
      rateConNumber: "RC-123",
      proNumber: "PRO-456",
      commodity: "Steel coils",
      stops
    });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.input).toMatchObject({ rateConNumber: "RC-123", proNumber: "PRO-456", commodity: "Steel coils" });
    expect(q.input.stops[0]).toMatchObject({ facility: "Dock B", contactName: "Pat", contactPhone: "555-0222", notes: "Lumper req" });
  });

  test("stop_off extras flow safely into accounting fallback, supplemental kinds, and primary invoice validation", () => {
    expect(lineKindOf("Stop-off / Reconsignment: added drop")).toBe("stop_off");
    expect(ACCOUNT_KEYS.find((k) => k.key === "stop_off")?.fallback).toBe("Accessorial Income");
    expect(SUPPLEMENTAL_KINDS.includes("stop_off")).toBe(true);

    const extras = parseBilledExtras([{ id: "e1", kind: "stop_off", label: "Reconsignment: extra stop", amount: 150, at: "2027-02-01T12:00:00Z" }]);
    expect(extras).toHaveLength(1);
    expect(unbilledExtrasOf(extras, [])).toHaveLength(1);
    expect(unbilledExtrasOf(extras, [{ label: "Reconsignment: extra stop", amount: 150 }])).toHaveLength(0);

    const invCheck = validateInvoice(
      { number: "INV-P6", terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" },
      { rate: 1000, surcharge: 0, detention: 0, rateLabel: "Agreed rate", defaultTerms: 30, billedExtras: extras }
    );
    expect(invCheck.ok).toBe(true);
    if (!invCheck.ok) return;
    expect(invCheck.value.total).toBe(1150);
    expect(invCheck.value.lines).toEqual([
      { label: "Agreed rate", amount: 1000 },
      { label: "Reconsignment: extra stop", amount: 150 }
    ]);
  });

  test("ROAD_ROUTE_NOTE warns about car route / truck restrictions and invoice PDF renders RC/PRO/BOL", async () => {
    expect(ROAD_ROUTE_NOTE.startsWith("Car route — check truck restrictions.")).toBe(true);

    const pdf = await buildInvoicePdf({
      kind: "invoice",
      number: "INV-REF-1",
      issued: "Feb 1, 2027",
      due: "Mar 3, 2027",
      termsLabel: "Net 30",
      status: "invoiced",
      issuer: { name: "TrueLane Fleet", address: null, mc: null, dot: null, phone: null, email: null, remitTo: null, paymentNote: null },
      billTo: { name: "Broker Co", mc: null, email: null, phone: null },
      loads: [
        {
          loadNumber: "TMS-55",
          rateCon: "RC-88",
          pro: "PRO-99",
          bol: "BOL-11",
          po: "PO-22",
          origin: "Dallas, TX",
          destination: "Austin, TX",
          pickedUp: "Feb 1",
          delivered: "Feb 1",
          refs: [],
          lines: [{ label: "Agreed rate", amount: 1200 }]
        }
      ],
      invoiceLines: [{ label: "Agreed rate", amount: 1200 }],
      total: 1200,
      received: 0,
      credited: 0,
      balance: 1200,
      creditOf: null,
      factoring: null
    });
    const text = await pdfText(pdf);
    expect(text).toContain("RC RC-88");
    expect(text).toContain("PRO PRO-99");
    expect(text).toContain("BOL BOL-11");
  });
});
