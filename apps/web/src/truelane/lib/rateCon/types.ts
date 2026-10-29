// VENDORED from TrueLane lib/rateCon/types.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Rate con extraction — the shape returned by the `rate-con-extract` Edge Function.
 * Keep in sync with supabase/functions/rate-con-extract/schema.ts (the JSON schema Claude fills).
 * Every field is nullable: the extractor is told never to guess.
 */

export type RateConStop = {
  type: 'pickup' | 'delivery';
  name: string | null;
  address: string | null;
  /** Local calendar date on the rate con, YYYY-MM-DD. */
  appointmentDate: string | null;
  /** Local start time of the appointment/window, HH:MM (24h). Null when only a date is given. */
  appointmentTime: string | null;
  /** 'appointment' = a set time; 'window' = FCFS / open hours / a range. */
  appointmentType: 'appointment' | 'window' | null;
  /** End of a window, HH:MM (24h). */
  windowEndTime: string | null;
  /** PU# / delivery # / BOL / confirmation numbers printed for this stop. */
  referenceNumbers: string[];
  /** The stop's own contact person / phone (never the broker's), as printed. */
  contactName: string | null;
  contactPhone: string | null;
  /** Short check-in / dock instructions printed for this stop. */
  instructions: string | null;
};

export type RateConAccessorial = { description: string; amount: number | null };

export type RateConExtraction = {
  /** Issue / signature date, YYYY-MM-DD. */
  issuedDate: string | null;
  broker: {
    name: string | null;
    mcNumber: string | null;
    dotNumber: string | null;
    phone: string | null;
    email: string | null;
  };
  /** The company hauling the load (the driver's own). Used to keep it OUT of the broker fields. */
  carrier: { name: string | null; mcNumber: string | null };
  loadNumber: string | null;
  poNumber: string | null;
  stops: RateConStop[];
  rate: {
    total: number | null;
    lineHaul: number | null;
    fuelSurcharge: number | null;
    accessorials: RateConAccessorial[];
  };
  paymentTermsDays: number | null;
  weightLbs: number | null;
  /** Freight dimensions: feet, feet, inches. */
  dimensions: { lengthFt: number | null; widthFt: number | null; heightIn: number | null };
  commodity: string | null;
  equipment: string | null;
  detentionTerms: string | null;
  notes: string | null;
  /** The only pay is a TONU (truck ordered not used) — the load wasn't hauled. */
  /** The loaded miles the rate con itself prints (a broker's own number), when it prints one. A cross-check, never the trip's miles. */
  milesPrinted: number | null;
  /** The payment terms as printed ("NET 30", "28DAYS", "ACH upon delivery"), for the app-side normalizer. */
  paymentTermsText: string | null;
  /** Detention as numbers, when the rate con prints them: free time, hourly rate, cap. */
  detention: { freeMinutes: number | null; hourlyRate: number | null; maxAmount: number | null };
  /** Temperature control, when printed (a reefer): set point or range in Fahrenheit and how it runs. */
  temperature: { setPointF: number | null; minF: number | null; maxF: number | null; mode: 'continuous' | 'cycle' | null };
  tonuOnly: boolean;
  /** Specific doubts the reader flagged for the driver to double-check. */
  warnings: string[];
  /** Present only when this was read from dispatch screenshots (lib/rateCon/dispatchBasis.ts): there is no broker or payment terms on a dispatch. */
  dispatch?: DispatchInfo;
};

/** What a dispatch screen adds: who dispatched it, whether the rate was hidden behind an eye icon, and the status printed on the card. */
export type DispatchInfo = {
  dispatcherName: string | null;
  dispatcherPhone: string | null;
  companyName: string | null;
  /** A rate is there but hidden (an eye icon): the driver types it. */
  rateHidden: boolean;
  /** As printed: Paid, Canceled, TONU, ... */
  status: string | null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const positive = (v: unknown): number | null => (num(v) != null && num(v)! > 0 ? num(v) : null);

/**
 * Defensive parse of the function's JSON. Never throws; unknown / wrong-typed fields become null
 * or empty. Returns null only when the payload isn't an object at all.
 */
export function parseRateConExtraction(raw: unknown): RateConExtraction | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const b = obj(r.broker);
  const c = obj(r.carrier);
  const d = obj(r.dimensions);
  const rate = obj(r.rate);
  const disp = obj(r.dispatch);
  const dispatch: DispatchInfo | null =
    r.dispatch != null && typeof r.dispatch === 'object' && !Array.isArray(r.dispatch)
      ? { dispatcherName: str(disp.dispatcherName), dispatcherPhone: str(disp.dispatcherPhone), companyName: str(disp.companyName), rateHidden: disp.rateHidden === true, status: str(disp.status) }
      : null;
  return {
    ...(dispatch ? { dispatch } : {}),
    issuedDate: str(r.issuedDate),
    broker: {
      name: str(b.name),
      mcNumber: str(b.mcNumber),
      dotNumber: str(b.dotNumber),
      phone: str(b.phone),
      email: str(b.email),
    },
    carrier: { name: str(c.name), mcNumber: str(c.mcNumber) },
    loadNumber: str(r.loadNumber),
    poNumber: str(r.poNumber),
    stops: arr(r.stops).map((s) => {
      const o = obj(s);
      return {
        type: o.type === 'pickup' ? 'pickup' : 'delivery',
        name: str(o.name),
        address: str(o.address),
        appointmentDate: str(o.appointmentDate),
        appointmentTime: str(o.appointmentTime),
        appointmentType: o.appointmentType === 'appointment' || o.appointmentType === 'window' ? o.appointmentType : null,
        windowEndTime: str(o.windowEndTime),
        referenceNumbers: [
          ...new Set(
            arr(o.referenceNumbers)
              .map((n) => str(n))
              .filter((n): n is string => n != null)
          ),
        ],
        contactName: str(o.contactName),
        contactPhone: str(o.contactPhone),
        instructions: str(o.instructions),
      } satisfies RateConStop;
    }),
    rate: {
      total: num(rate.total),
      lineHaul: num(rate.lineHaul),
      fuelSurcharge: num(rate.fuelSurcharge),
      accessorials: arr(rate.accessorials)
        .map((a) => obj(a))
        .filter((a) => str(a.description) != null)
        .map((a) => ({ description: str(a.description)!, amount: num(a.amount) })),
    },
    paymentTermsDays: num(r.paymentTermsDays),
    weightLbs: num(r.weightLbs),
    dimensions: { lengthFt: num(d.lengthFt), widthFt: num(d.widthFt), heightIn: num(d.heightIn) },
    commodity: str(r.commodity),
    equipment: str(r.equipment),
    detentionTerms: str(r.detentionTerms),
    notes: str(r.notes),
    milesPrinted: positive(r.milesPrinted),
    paymentTermsText: str(r.paymentTermsText),
    detention: (() => {
      const o = obj(r.detention);
      return {
        freeMinutes: positive(o.freeMinutes ?? r.detentionFreeMinutes),
        hourlyRate: positive(o.hourlyRate ?? r.detentionHourlyRate),
        maxAmount: positive(o.maxAmount),
      };
    })(),
    temperature: (() => {
      const o = obj(r.temperature);
      const f = (v: unknown): number | null => (num(v) != null && num(v)! >= -60 && num(v)! <= 120 ? num(v) : null);
      return { setPointF: f(o.setPointF), minF: f(o.minF), maxF: f(o.maxF), mode: o.mode === 'continuous' || o.mode === 'cycle' ? o.mode : null };
    })(),
    tonuOnly: r.tonuOnly === true,
    warnings: arr(r.warnings)
      .map((w) => str(w))
      .filter((w): w is string => w != null)
      .slice(0, 6),
  };
}

/** The rate con's all-in pay: stated total, else line haul + fuel surcharge + accessorials. */
export function rateConTotal(x: RateConExtraction): number | null {
  if (x.rate.total != null) return x.rate.total;
  if (x.rate.lineHaul == null) return null;
  const acc = x.rate.accessorials.reduce((s, a) => s + (a.amount ?? 0), 0);
  return x.rate.lineHaul + (x.rate.fuelSurcharge ?? 0) + acc;
}
