// VENDORED from TrueLane supabase/functions/rate-con-extract/core.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
// ============================================================================================
//  rate-con-extract — pure core (no Deno APIs, no imports) so jest + tsc can check it from the app
//  side (lib/rateCon/extractCore.test.ts). index.ts wires HTTP, Clerk, Storage and the SDK around it.
//  Keep the extraction shape in sync with lib/rateCon/types.ts (the app parses it defensively).
// ============================================================================================

/**
 * Model for extraction. Default per the Claude API reference: Claude Opus 5 (~$0.05–0.08 per 2–3 page
 * rate con). One-line swap if cost matters more than accuracy on messy scans:
 *   'claude-sonnet-5'  (~$0.02–0.03)   |   'claude-haiku-4-5' (~$0.01 — no adaptive thinking/effort:
 *   drop `thinking` and `output_config.effort` in buildExtractionParams if you switch to Haiku).
 */
export const RATE_CON_MODEL = 'claude-opus-5';

/** Server-side refusal fallback ("default" = Anthropic picks the fallback model by refusal category). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const DAILY_LIMIT = 25;
/** A free account's failed reads a day: they cost money and count toward no allowance, so they have their own ceiling. */
export const FAILED_DAILY_LIMIT_FREE = 10;
/** Import (a rate con or a dispatch) is part of Pro; a free account has it while its 30-day trial is open (same length as lib/trialStatus TRIAL_DURATION_MS). */
export const IMPORT_TRIAL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * The whole request has this long before the phone gives up (lib/rateCon/client.ts waits READ_TIMEOUT_MS = 65 s). The Anthropic call gets what is
 * left of it, so the function always answers (504 read_timeout) while the phone is still listening, and a late finish never writes an "ok" row
 * (and never uses up a free read) after the phone has already shown an error and deleted the file. The SDK's own default is 10 minutes and 2 retries.
 */
export const REQUEST_BUDGET_MS = 55_000;
/** One retry on a 429 / 5xx only when at least this much of the budget is left. */
export const RETRY_MIN_LEFT_MS = 15_000;
/** The same file read again by the same user inside this window is answered from the stored reading (no model call, no meter). */
export const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const SUPPORTED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export type SupportedMime = (typeof SUPPORTED_MIME)[number];

export function isSupportedMime(m: unknown): m is SupportedMime {
  return typeof m === 'string' && (SUPPORTED_MIME as readonly string[]).includes(m);
}

/** The file must live under the caller's own rate-con folder. */
export function isAllowedPath(sub: string, path: unknown): path is string {
  if (typeof path !== 'string' || !sub) return false;
  if (path.includes('..') || path.includes('//')) return false;
  return path.startsWith(`${sub}/ratecons/`) && path.length > `${sub}/ratecons/`.length;
}

// ---- JSON schema Claude fills (structured outputs: every object additionalProperties:false, every property required).
// ---- ZERO union parameters: Anthropic refuses a strict schema with more than 16 nullable / anyOf / type-array parameters
// ---- ("Schema is too complex" 400), and the old nullable schema had 37, so every read failed. So "not printed" is "" (text),
// ---- "none" (appointmentType) or an empty array, and money and counts are TEXT copied as printed ("$2,075.00"): the code
// ---- below (parseAmount / normalizeExtraction) turns that back into the nullable shape the app, the stored `extracted` JSON
// ---- and Community eligibility already read. Format rules live in descriptions because pattern/length constraints aren't supported.
const T = (description: string) => ({ type: 'string', description }) as const;
// Money and counts are copied as printed; parseAmount reads them. "" when not printed.
const A = (description: string) => ({ type: 'string', description: `${description}. Copy the figure as printed ("$2,075.00", "42,000"); "" when not printed` }) as const;

export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'issuedDate', 'broker', 'carrier', 'loadNumber', 'poNumber', 'stops', 'rate', 'paymentTermsDays',
    'weightLbs', 'dimensions', 'commodity', 'equipment', 'detentionTerms', 'notes', 'tonuOnly', 'warnings',
    'milesPrinted', 'paymentTermsText', 'detentionFreeMinutes', 'detentionHourlyRate',
  ],
  properties: {
    issuedDate: T('Date the rate con was issued or signed, YYYY-MM-DD; "" if not printed'),
    broker: {
      type: 'object',
      additionalProperties: false,
      description: 'The company that ISSUED the rate con and pays the carrier (the broker / logistics company). Never the carrier.',
      required: ['name', 'mcNumber', 'dotNumber', 'phone', 'email'],
      properties: {
        name: T('Broker company name (often only in the logo, header, footer or legal text); "" if not printed'),
        mcNumber: T("The BROKER's MC number, digits only — \"\" unless it is clearly labeled as the broker's"),
        dotNumber: T("The BROKER's USDOT number — \"\" unless clearly the broker's"),
        phone: T('Broker dispatcher / rep phone; "" if not printed'),
        email: T('Broker dispatcher / rep email; "" if not printed'),
      },
    },
    carrier: {
      type: 'object',
      additionalProperties: false,
      description: 'The trucking company HAULING the load (the app user) — usually a box labeled Carrier, with its own MC/DOT.',
      required: ['name', 'mcNumber'],
      properties: {
        name: T('Carrier company name; "" if not printed'),
        mcNumber: T("The CARRIER's MC number, digits only; \"\" if not printed"),
      },
    },
    loadNumber: T("The broker's main ID for this load, whatever it is called: Load #, Order #, PRO #, BOL #, Confirmation #, or the PO # when that is the only ID; \"\" if none"),
    poNumber: T('A purchase order number ONLY when printed in addition to a different load number; otherwise ""'),
    stops: {
      type: 'array',
      description: 'Every pickup and delivery in the order printed',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'type', 'name', 'address', 'appointmentDate', 'appointmentTime', 'appointmentType', 'windowEndTime',
          'referenceNumbers', 'contactName', 'contactPhone', 'instructions',
        ],
        properties: {
          type: { type: 'string', enum: ['pickup', 'delivery'] },
          name: T('Facility name; "" if not printed'),
          address: T('Street, city, state, ZIP as printed (city/state only if that is all that is printed); "" if not printed'),
          appointmentDate: T('Local date, YYYY-MM-DD; "" if not printed'),
          appointmentTime: T('Local appointment time, or the START of a window, 24-hour HH:MM; "" if only a date is given'),
          appointmentType: {
            type: 'string',
            enum: ['appointment', 'window', 'none'],
            description: 'appointment = a set time; window = FCFS / open hours / a time range; none = no time given',
          },
          windowEndTime: T('END of a window, 24-hour HH:MM; "" for a set appointment'),
          referenceNumbers: {
            type: 'array',
            description: 'Labeled pickup / release / delivery / appointment / confirmation / BOL / S.O. numbers for THIS stop — including ones printed in the stop notes or a PO box (e.g. "release# X", "PU# X"). Split "A / B" into two.',
            items: { type: 'string' },
          },
          contactName: T('Contact person printed for THIS stop (shipping/receiving contact); "" if none'),
          contactPhone: T("Phone printed for THIS stop's facility or contact, as printed (keep any ext.); never the broker's or carrier's number; \"\" if none"),
          instructions: T('Short driver instructions printed for THIS stop (check-in, gate, dock, hours, PPE); "" if none'),
        },
      },
    },
    rate: {
      type: 'object',
      additionalProperties: false,
      required: ['total', 'lineHaul', 'fuelSurcharge', 'accessorials'],
      properties: {
        total: A('Total carrier pay in US dollars (Total, Total Rate, Total Due, All-in, Agreed amount)'),
        lineHaul: A('Line haul / flat rate ONLY when printed as its own line; never copy the total here'),
        fuelSurcharge: A('Fuel surcharge in US dollars for the whole load, only when printed as its own line'),
        accessorials: {
          type: 'array',
          description: 'Other pay lines that are part of the agreed total (e.g. stop-off, driver assist). Not penalties, not optional quick-pay fees.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['description', 'amount'],
            properties: {
              description: { type: 'string' },
              amount: A('US dollars'),
            },
          },
        },
      },
    },
    paymentTermsDays: A('Standard days to pay as a bare number, e.g. "Net 30", "30 days", "28DAYS" → "30" / "28". Not quick-pay terms'),
    weightLbs: A('Freight weight in pounds'),
    dimensions: {
      type: 'object',
      additionalProperties: false,
      description: 'Freight (not trailer) dimensions when printed, e.g. "20\' L x 8\' W x 4\' H"',
      required: ['lengthFt', 'widthFt', 'heightIn'],
      properties: {
        lengthFt: A('Freight length in feet'),
        widthFt: A('Freight width in feet (8\'6" = 8.5)'),
        heightIn: A('Freight height in INCHES (4 ft = 48)'),
      },
    },
    commodity: T('Commodity / freight description; "" if not printed'),
    equipment: T('Required equipment / trailer as printed; "" if not printed'),
    detentionTerms: T('Detention, layover and TONU terms in one short sentence (use the terms that apply to this load when several protocols are printed); "" if none'),
    notes: T('Load-specific instructions a driver must know (PPE, paperwork, tracking, no early delivery), one or two short sentences; "" if none'),
    tonuOnly: {
      type: 'boolean',
      description: 'true when the only pay on this document is a TONU (Truck Ordered Not Used) / cancellation payment — the load was not hauled; otherwise false',
    },
    warnings: {
      type: 'array',
      description: 'Short plain-English doubts about this document a driver should double-check (e.g. a later stop dated before an earlier one, no year printed, two different load IDs). Empty if none.',
      items: { type: 'string' },
    },
    milesPrinted: A('Total loaded miles the rate con itself prints (labeled Miles, Total miles, Distance, Mileage, Trip miles). Only a printed number; "" when none is printed. Never compute it, never use weight or a count'),
    paymentTermsText: T('The payment terms exactly as printed, short (e.g. "NET 30", "28DAYS", "30 days from receipt of invoice", "ACH upon delivery"). If only a quick-pay offer or an invoicing deadline is printed, copy that phrase. "" if nothing about payment timing is printed.'),
    detentionFreeMinutes: A('Detention free time in MINUTES as a bare number (2 hours = 120), only when printed as a number; "" for "no detention" or when not printed'),
    detentionHourlyRate: A('Detention rate in US dollars per hour, only when printed as a number'),
  },
} as const;

export const SYSTEM_PROMPT = [
  'You read trucking rate confirmations (rate cons) for an owner-operator app. Extract only what is printed.',
  'If a field is not on the document or is unreadable, leave it empty: "" for text, money and numbers, "none" for appointmentType, an empty array for lists, false for tonuOnly. Wherever the rules below say null, that means empty. Never guess or use outside knowledge.',
  'Money and numbers are text: copy the figure as printed ("$2,075.00"). Never add figures together; if a total is not printed as one figure, leave it empty.',
  '',
  'Rules learned from real rate cons:',
  '- Two companies appear. The BROKER issued the document and pays; the CARRIER hauls the load (the app user).',
  "  The prominent MC#/DOT#/name box is very often the CARRIER's. Put it under carrier, never under broker.",
  "  Fill broker.mcNumber only when an MC number is clearly the broker's; many rate cons don't print it.",
  '  The broker name is often only in the logo, title, footer, remit-to or legal text.',
  '- loadNumber is the broker\'s main ID for the load, whatever it is called (Load #, Order #, PRO #, BOL #, or a PO # in the title when it is the only ID).',
  '- Pickup numbers are also called release numbers (PU#, Pickup #, Release #, Release No, Order #, S.O. #). They are often printed in stop notes or in a "Purchase Order #" box (e.g. "release# X"). Split "A / B" into two numbers.',
  '- Reference numbers must be labeled as such. Do not use line/item numbers from a commodity table, seal numbers, phone numbers, VIN/serial numbers or document IDs.',
  '- Dates: output YYYY-MM-DD. When a stop date has no year, take the year from the issue or signature date on the same document and add a warning.',
  '- Times: 24-hour HH:MM. "FCFS 08:00 to 17:00", "ETA 1100-1130" or shipping hours "7:30-3" are windows (start, end). "Appt 07:30" or facility hours "14:30-14:30" is an appointment. "Deliver by 4PM" is a window with no start and end 16:00. A time of 00:00 with no other time is a placeholder: use null.',
  '- A stop date range across days ("10/23 - 10/24"): use the first date and add a warning.',
  '- Money: plain numbers, no symbols or commas. total is the agreed total. lineHaul and fuelSurcharge only when printed as separate lines; if only one amount is printed, it is the total. Quick-pay discounts, fines and penalties are not pay.',
  '- Payment terms like "30 days", "Net 30" or "28DAYS" go in paymentTermsDays; quick-pay offers do not. "Business days" → the number printed plus a warning. "Upon delivery" / "ACH on delivery" → null, and say so in notes.',
  '- If the only pay is a TONU (Truck Ordered Not Used) or cancellation fee, set tonuOnly true and add a warning.',
  '- Freight dimensions (L x W x H, or "42 FEET ... 126 INCHES TALL ... 102 INCHES WIDE" in instructions): length and width in FEET (102 in = 8.5 ft), height in INCHES (4 ft = 48). Feet-inches like 8\'1 = 8.08 ft, 9\'6 = 114 in. Zero placeholders like 0x0x0 mean not given (null). Not trailer size.',
  '- The broker MC may be labeled "Docket". A broker can be a trucking company acting as broker.',
  '- Stops keep the label printed, in the printed order: PICK / PU / pickup / shipper / origin = pickup; DROP / SO (stop-off, ship-to) / delivery / consignee / receiver / final destination = delivery. Header dates like "Ready Date" / "Date Needed" belong to the first pickup / last delivery when the stop itself has no date.',
  '- A reference number is an ID code. Words describing the freight (e.g. a commodity name in a "BOL" or "Reference" box) are not reference numbers. List a number once even if it repeats in several boxes (e.g. Customer PO = Shipper Ref).',
  "- Stop contacts: contactName / contactPhone only when printed for that stop (e.g. \"Contact:\", \"Shipping:\", \"Receiving:\", a phone next to the facility). The broker's dispatcher or rep and the carrier's own numbers go elsewhere, never on a stop. instructions: the stop's own notes, shortened (under 25 words), without reference numbers or appointment times already captured.",
  '- If a stop shows a window but its instructions give a specific time ("6AM SHARP"), use the specific time as the appointment and add a warning.',
  '- Put specific doubts in warnings (dates out of order, no year printed, conflicting terms, a value in the wrong box). Keep each under 15 words.',
  '- Never reorder stops by date or distance. Keep the printed order; if the dates contradict it, keep the printed order and add a warning.',
  '- equipment keeps everything printed about the trailer: type, length and options ("Dry Van 53ft air ride", "Reefer 53ft", "Flatbed or Step Deck", "Power only"). If several trailers are allowed, keep all of them.',
  '- milesPrinted is the loaded mileage the document itself prints (Miles, Distance, Total miles). Only a printed number: do not add up legs, do not use weight, pieces or a reference number.',
  '- paymentTermsText is the phrase that says when the carrier is paid, copied short and as printed. Business days, "upon delivery", factoring notes and quick-pay offers are copied as printed; the app interprets them.',
  '- detentionFreeMinutes and detentionHourlyRate are numbers only: free time in MINUTES (2 hours = 120) and the dollar rate per hour. "No detention", "none paid" or no figures: both null. Keep the sentence in detentionTerms as well.',
  '- For a refrigerated or temperature-controlled load, put the temperature in equipment exactly as printed, in degrees Fahrenheit with how it runs ("Reefer 53ft, 34F continuous"). Pre-cool instructions go in notes.',
  '- notes: when the document requires any of these, say so in a few words each: team drivers, hazmat or placards, TWIC, tarps, ramps, liftgate, pallet jack, lumper or driver assist, load tracking or check calls, a seal, no-touch freight, pallet exchange, drop and hook.',
  'Keep text fields short and as printed.',
].join('\n');

export const USER_INSTRUCTION = 'Extract this rate confirmation into the required JSON.';

export type ExtractionParams = {
  model: string;
  max_tokens: number;
  betas: string[];
  fallbacks: 'default';
  thinking: { type: 'adaptive' };
  output_config: { effort: 'low'; format: { type: 'json_schema'; schema: Record<string, unknown> } };
  system: string;
  messages: Array<{
    role: 'user';
    content: Array<
      | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
      | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/webp'; data: string } }
      | { type: 'text'; text: string }
    >;
  }>;
};

/** Request body for client.beta.messages.create. The file block goes before the text block. */
export function buildExtractionParams(mime: SupportedMime, base64: string): ExtractionParams {
  const fileBlock =
    mime === 'application/pdf'
      ? ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as const)
      : ({ type: 'image', source: { type: 'base64', media_type: mime, data: base64 } } as const);
  return {
    model: RATE_CON_MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown> },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: USER_INSTRUCTION }] }],
  };
}

export type ReadResult = { ok: true; extraction: Record<string, unknown> } | { ok: false; reason: string };

/** Pull the JSON out of the response. Checks stop_reason before reading content. */
export function readExtraction(res: {
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
}): ReadResult {
  if (res.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
  if (res.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
  const text = res.content.find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
  if (!text) return { ok: false, reason: 'no_text' };
  try {
    const parsed = JSON.parse(text);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'not_object' };
    return { ok: true, extraction: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'bad_json' };
  }
}

// ---- Reading the zero-union answer back into the nullable shape everything downstream reads ----

const AMOUNT_TOKEN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+/g;

/**
 * A figure copied as printed ("$2,075.00", "2075", "2,075.00 USD", "Net 30") → the number. Exactly one number in the text, or null:
 * "$1,800 + $275" (two figures) is never summed or guessed, and "TBD" / "" is simply not there. `ambiguous` is true when the text had
 * several figures, so the caller can tell the driver to check it.
 */
export function parseAmount(v: unknown): { value: number | null; ambiguous: boolean } {
  if (typeof v === 'number') return { value: Number.isFinite(v) ? v : null, ambiguous: false };
  if (typeof v !== 'string') return { value: null, ambiguous: false };
  const tokens = v.match(AMOUNT_TOKEN) ?? [];
  if (tokens.length === 0) return { value: null, ambiguous: false };
  if (tokens.length > 1) return { value: null, ambiguous: true };
  const n = Number(tokens[0]!.replace(/,/g, ''));
  return { value: Number.isFinite(n) ? n : null, ambiguous: false };
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const record = (v: unknown): Record<string, unknown> => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The stops of a reading, "" and "none" turned back into null. Tolerates the old nullable shape too, so an earlier stored reading maps to itself. */
export function normalizeStops(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => {
    const o = record(s);
    const refs = Array.isArray(o.referenceNumbers) ? o.referenceNumbers.map((r) => text(r)).filter((r): r is string => r != null) : [];
    return {
      type: o.type,
      name: text(o.name),
      address: text(o.address),
      appointmentDate: text(o.appointmentDate),
      appointmentTime: text(o.appointmentTime),
      appointmentType: o.appointmentType === 'appointment' || o.appointmentType === 'window' ? o.appointmentType : null,
      windowEndTime: text(o.windowEndTime),
      referenceNumbers: refs,
      contactName: text(o.contactName),
      contactPhone: text(o.contactPhone),
      instructions: text(o.instructions),
    };
  });
}

/**
 * The reading the model returns (zero unions: "" for not printed, money as text) → the extraction the app plans a load from, which is also what is
 * stored in `extracted` and read by Community eligibility: null for not printed, numbers as numbers. A figure the document printed more than once
 * ("Line Haul + Fuel: $1,800 + $275") becomes null with a warning, never a sum. Safe on the old nullable shape too (an older stored reading, a cached eval reading).
 */
export function normalizeExtraction(raw: Record<string, unknown>): Record<string, unknown> {
  const warnings: string[] = Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === 'string') : [];
  const amount = (v: unknown, label: string): number | null => {
    const { value, ambiguous } = parseAmount(v);
    if (ambiguous) warnings.push(`${label} printed as "${String(v).trim().slice(0, 40)}": check it`);
    return value;
  };
  const broker = record(raw.broker);
  const carrier = record(raw.carrier);
  const rate = record(raw.rate);
  const dims = record(raw.dimensions);
  const total = amount(rate.total, 'Rate total');
  const lineHaul = amount(rate.lineHaul, 'Line haul');
  const fuelSurcharge = amount(rate.fuelSurcharge, 'Fuel surcharge');
  const accessorials = (Array.isArray(rate.accessorials) ? rate.accessorials : []).map((a) => {
    const o = record(a);
    return { description: typeof o.description === 'string' ? o.description : '', amount: amount(o.amount, 'An extra pay line') };
  });
  return {
    issuedDate: text(raw.issuedDate),
    broker: { name: text(broker.name), mcNumber: text(broker.mcNumber), dotNumber: text(broker.dotNumber), phone: text(broker.phone), email: text(broker.email) },
    carrier: { name: text(carrier.name), mcNumber: text(carrier.mcNumber) },
    loadNumber: text(raw.loadNumber),
    poNumber: text(raw.poNumber),
    stops: normalizeStops(raw.stops),
    rate: { total, lineHaul, fuelSurcharge, accessorials },
    paymentTermsDays: amount(raw.paymentTermsDays, 'Payment days'),
    weightLbs: amount(raw.weightLbs, 'Weight'),
    dimensions: { lengthFt: amount(dims.lengthFt, 'Length'), widthFt: amount(dims.widthFt, 'Width'), heightIn: amount(dims.heightIn, 'Height') },
    commodity: text(raw.commodity),
    equipment: text(raw.equipment),
    detentionTerms: text(raw.detentionTerms),
    notes: text(raw.notes),
    tonuOnly: raw.tonuOnly === true,
    warnings,
    milesPrinted: amount(raw.milesPrinted, 'Miles'),
    paymentTermsText: text(raw.paymentTermsText),
    detentionFreeMinutes: amount(raw.detentionFreeMinutes, 'Detention free time'),
    detentionHourlyRate: amount(raw.detentionHourlyRate, 'Detention rate'),
  };
}

export type PdfSignals = {
  pdfVersion: string | null;
  producer: string | null;
  creator: string | null;
  creationDate: string | null;
  modDate: string | null;
  /**
   * Count of %%EOF markers. A SOFT integrity signal only: incremental saves (edits after the file
   * was made) append another %%EOF, but some legitimate PDF producers also write several. Capture
   * it, never score it or block on it without evidence (docs/reference/RATE_DATA_INTEGRITY.md).
   */
  eofCount: number;
};

function latin1(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function infoString(text: string, key: string): string | null {
  // Uncompressed Info-dict literal string, e.g. /Producer (Microsoft® Word) — best effort only;
  // compressed object streams hide it, which just yields null.
  const m = new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(text);
  if (!m) return null;
  const v = m[1]!.replace(/\\(.)/g, '$1').trim();
  return v ? v.slice(0, 200) : null;
}

const INFO_KEYS = ['Producer', 'Creator', 'CreationDate', 'ModDate'] as const;
const INFO_KEY_BYTES = INFO_KEYS.map((k) => Array.from(k, (c) => c.charCodeAt(0)));
/** How much of the file after a "/Producer" (etc.) is decoded to read its value: a literal string, never more than a few hundred bytes. */
const INFO_WINDOW = 700;

function startsWithAt(bytes: Uint8Array, at: number, want: number[]): boolean {
  if (at + want.length > bytes.length) return false;
  for (let i = 0; i < want.length; i++) if (bytes[at + i] !== want[i]) return false;
  return true;
}

/**
 * The PDF's own metadata. ONE pass over the bytes (no 20 MB string, no regex over the whole file): the Edge runtime allows 2 seconds of CPU per
 * request, and decoding a scanned PDF to text and scanning it five times was the biggest file-sized cost in this function. Only a few hundred bytes
 * after each "/Producer" style key are ever decoded.
 */
export function pdfSignals(bytes: Uint8Array): PdfSignals {
  const version = /^%PDF-(\d\.\d)/.exec(latin1(bytes.subarray(0, 16)));
  const found: Array<string | null> = [null, null, null, null];
  let eofCount = 0;
  const n = bytes.length;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0x25) {
      // %%EOF
      if (bytes[i + 1] === 0x25 && bytes[i + 2] === 0x45 && bytes[i + 3] === 0x4f && bytes[i + 4] === 0x46) {
        eofCount++;
        i += 4;
      }
    } else if (b === 0x2f) {
      for (let k = 0; k < INFO_KEYS.length; k++) {
        if (found[k] !== null || !startsWithAt(bytes, i + 1, INFO_KEY_BYTES[k]!)) continue;
        found[k] = infoString(latin1(bytes.subarray(i, i + INFO_WINDOW)), INFO_KEYS[k]!);
      }
    }
  }
  return {
    pdfVersion: version ? version[1]! : null,
    producer: found[0],
    creator: found[1],
    creationDate: found[2],
    modDate: found[3],
    eofCount,
  };
}

export function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** UTC calendar-month and calendar-day starts for metering windows. */
export function meteringWindows(now: Date): { monthStart: string; dayStart: string } {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  return { monthStart, dayStart };
}

/**
 * What the server knows about the caller from Clerk, and can trust: the tier and the beta flag are public metadata (the app cannot write it), and
 * `created_at` is Clerk's own. The phone's trial clock (unsafeMetadata.trialStartedAt) is writable by the user, so it is never used here.
 */
export type ImportAccount = { tier: string; betaAccess: boolean; createdAtMs: number | null };

/** The ImportAccount in a Clerk user object (the backend API's JSON). Anything unreadable is a free account with no known start. */
export function importAccountOf(user: unknown, now: number = Date.now()): ImportAccount {
  const u = (user != null && typeof user === 'object' ? user : {}) as Record<string, unknown>;
  const pm = (u.public_metadata != null && typeof u.public_metadata === 'object' ? u.public_metadata : {}) as Record<string, unknown>;
  const tier = pm.tier === 'tier1' || pm.tier === 'tier2' ? pm.tier : 'free';
  const until = pm.beta_access_until;
  // The same rule as lib/betaAccess.ts betaAccessActive: set by hand in the Clerk Dashboard, optionally ending on a date; and an admin (`admin: true`) never ends.
  const betaAccess = pm.admin === true || (pm.beta_access === true && (until == null || (typeof until === 'number' && Number.isFinite(until) && until > now)));
  const created = u.created_at;
  return { tier, betaAccess, createdAtMs: typeof created === 'number' && Number.isFinite(created) && created > 0 ? created : null };
}

export type MeterDecision = { ok: true; via: 'paid' | 'beta' | 'trial' } | { ok: false; status: 402 | 429; error: 'trial_ended' | 'daily_limit' };

/**
 * Who may read a rate con or a dispatch. Paid (tier1 or tier2) and beta accounts: always. A free account: only while its trial is open (30 days from
 * the day the Clerk account was made); an account whose start is not known is not in a trial. Everyone: DAILY_LIMIT attempts a day; a free account:
 * FAILED_DAILY_LIMIT_FREE failed reads a day.
 */
export function meter(account: ImportAccount, attemptsToday: number, failedToday: number, now: number = Date.now()): MeterDecision {
  if (attemptsToday >= DAILY_LIMIT) return { ok: false, status: 429, error: 'daily_limit' };
  if (account.tier === 'tier1' || account.tier === 'tier2') return { ok: true, via: 'paid' };
  if (account.betaAccess) return { ok: true, via: 'beta' };
  const trialOpen = account.createdAtMs != null && account.createdAtMs + IMPORT_TRIAL_MS > now;
  if (!trialOpen) return { ok: false, status: 402, error: 'trial_ended' };
  if (failedToday >= FAILED_DAILY_LIMIT_FREE) return { ok: false, status: 429, error: 'daily_limit' };
  return { ok: true, via: 'trial' };
}

// ============================================================================================
//  What Anthropic's answer (or silence) means for the phone, and what the call cost. Pure, so jest checks it.
// ============================================================================================

/** The error classes the phone tells apart: busy (try again soon), too slow (read_timeout), refused request (a failed row), anything else upstream. */
export type UpstreamFailure =
  | { kind: 'respond'; status: 502 | 503 | 504; body: { error: 'busy_try_again' | 'read_timeout' | 'upstream_error' | 'upstream_unreachable'; upstream_status?: number | null } }
  | { kind: 'failed_row'; reason: 'bad_request'; detail: string };

export function upstreamFailure(info: { status: number | null; timedOut: boolean; message?: string }): UpstreamFailure {
  if (info.timedOut) return { kind: 'respond', status: 504, body: { error: 'read_timeout' } };
  const s = info.status;
  if (s === 429 || s === 529 || s === 503) return { kind: 'respond', status: 503, body: { error: 'busy_try_again', upstream_status: s } };
  // A 400 is Anthropic refusing THIS request (the schema, a parameter, the file). Keep the reason: it is the one thing that tells a schema problem from a bad file.
  if (s === 400) return { kind: 'failed_row', reason: 'bad_request', detail: String(info.message ?? '').slice(0, 300) };
  if (typeof s === 'number') return { kind: 'respond', status: 502, body: { error: 'upstream_error', upstream_status: s } };
  return { kind: 'respond', status: 502, body: { error: 'upstream_unreachable' } };
}

/** One retry is worth it for a busy or broken upstream (429, any 5xx including 529), not for a refusal or a timeout. */
export function isRetryableStatus(status: number | null): boolean {
  return status === 429 || (typeof status === 'number' && status >= 500 && status <= 599);
}

/** Milliseconds of the request budget still left, never negative. */
export function budgetLeft(startedAt: number, now: number, budget: number = REQUEST_BUDGET_MS): number {
  return Math.max(0, budget - (now - startedAt));
}

export type Usage = { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };

/** Token counts from a response's `usage` (the cache fields tell whether the cached prompt is actually being hit). Null when the response has none. */
export function usageOf(res: unknown): Usage | null {
  const u = (res as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  return {
    input_tokens: n(u.input_tokens),
    output_tokens: n(u.output_tokens),
    cache_read_tokens: n(u.cache_read_input_tokens),
    cache_write_tokens: n(u.cache_creation_input_tokens),
  };
}

// ============================================================================================
//  Dispatch screenshots (kind: 'dispatch'): a driver who does not self-dispatch never gets a rate con; the dispatch
//  company's own app shows the load (load #, pickup and delivery windows, the rate behind an eye icon, the dispatcher's
//  name and phone, a status). One to three screenshots are read together, in ONE call, counted as ONE read. The reading is
//  mapped into the same extraction shape the app already plans a load from (broker fields null: a dispatcher is not a
//  broker), plus a `dispatch` block the review sheet uses. Screenshots are never shared to market rates.
// ============================================================================================

export type ReadKind = 'rate_con' | 'dispatch';
export const MAX_DISPATCH_IMAGES = 3;
export const SUPPORTED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME)[number];

export function isImageMime(m: unknown): m is SupportedImageMime {
  return typeof m === 'string' && (SUPPORTED_IMAGE_MIME as readonly string[]).includes(m);
}

export function readKindOf(v: unknown): ReadKind {
  return v === 'dispatch' ? 'dispatch' : 'rate_con';
}

/** One to three images, each under the caller's own rate-con folder, each an image type, with a matching list of types. */
export function isAllowedDispatchFiles(sub: string, paths: unknown, mimes: unknown): paths is string[] {
  if (!Array.isArray(paths) || !Array.isArray(mimes)) return false;
  if (paths.length < 1 || paths.length > MAX_DISPATCH_IMAGES || mimes.length !== paths.length) return false;
  if (new Set(paths).size !== paths.length) return false;
  return paths.every((p) => isAllowedPath(sub, p)) && mimes.every((m) => isImageMime(m));
}

export const DISPATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['loadNumber', 'stops', 'rate', 'rateHidden', 'dispatcher', 'companyName', 'status', 'weightLbs', 'commodity', 'equipment', 'notes', 'tonuOnly', 'warnings'],
  properties: {
    loadNumber: T("The load's main ID as printed (Load #, Order #, the # next to the status); \"\" if none"),
    stops: EXTRACTION_SCHEMA.properties.stops,
    rate: T('The rate in US dollars exactly as shown on the screen ("$500"); "" when it is hidden (an eye icon, asterisks) or not shown'),
    rateHidden: { type: 'boolean', description: 'true when a rate is clearly there but hidden (an eye icon, asterisks, dots), so the driver must type it' },
    dispatcher: {
      type: 'object',
      additionalProperties: false,
      description: "The dispatcher or dispatch contact printed for the load (often labeled Disp, Dispatcher, Contact)",
      required: ['name', 'phone'],
      properties: { name: T('Dispatcher name as printed; "" if none'), phone: T('Dispatcher phone as printed; "" if none') },
    },
    companyName: T('The dispatch company or carrier name, only when it is printed on the screen (a logo or header); else ""'),
    status: T('The load status exactly as printed (Paid, Canceled, TONU, Delivered, Active, In transit...), short; "" when none'),
    weightLbs: A('Freight weight in pounds, only when printed'),
    commodity: T('Commodity, only when printed; else ""'),
    equipment: T('Trailer or equipment, only when printed; else ""'),
    notes: T('Load-specific instructions printed on the screen, one or two short sentences; "" if none'),
    tonuOnly: { type: 'boolean', description: 'true when the status or text says the load was canceled and only a TONU (truck ordered not used) is paid; otherwise false' },
    warnings: {
      type: 'array',
      description: 'Short plain-English doubts the driver should double-check (two different loads in the screenshots, a cut-off card, dates out of order). Empty if none.',
      items: { type: 'string' },
    },
  },
} as const;

export const DISPATCH_PROMPT = [
  "You read screenshots of a load from a trucking dispatch company's app, for an owner-operator app. Extract only what is on the screen.",
  'The driver took one to three screenshots of the SAME load. Combine them into one load. If they clearly show different loads, read the first and add a warning.',
  'If a field is not on the screen or is unreadable, leave it empty: "" for text and the rate, "none" for appointmentType, an empty array for lists, false for tonuOnly. Wherever the rules below say null, that means empty. Never guess or use outside knowledge.',
  'The rate is text: copy the figure as printed ("$500", "500.00").',
  '',
  '- This is a dispatch, not a rate confirmation: there is usually no broker, no payment terms and no miles. Do not invent them.',
  '- Stops: PU / pickup / origin = pickup; DEL / delivery / destination = delivery, in the order printed. A line like "PU1: La Vergne, TN 37086" has the city, state and ZIP in address. Never reorder stops. A stop that shows in more than one screenshot (the same card scrolled, or the last stop of one shot repeated at the top of the next) is ONE stop: list it once.',
  '- Windows: "From: 09/29/2026 11:00 AM  To: 09/29/2026 04:00 PM" is a window: appointmentDate the date as YYYY-MM-DD, appointmentTime the start as 24-hour HH:MM, appointmentType window, windowEndTime the end as HH:MM. If from and to are the same time it is a set appointment (appointmentType appointment, windowEndTime null). If the end falls on another day, use the start day and add a warning.',
  '- Dates are printed month/day/year. Output YYYY-MM-DD.',
  '- The rate: a dollar figure next to "Rate" is the rate. When it is hidden behind an eye icon, asterisks or dots, return rate null and rateHidden true. Never use another number (a load number, a phone number, a total of something else) as the rate.',
  '- dispatcher: the person labeled Disp, Dispatcher or Contact and their phone, exactly as printed. Never the driver.',
  '- status: the label printed on the card (Paid, Canceled, TONU...). A card headed "Paid" with a check mark is a finished load: still read it, the app will say so.',
  '- Reference numbers are labeled ID codes only (PU#, DEL#, BOL). Leave referenceNumbers empty when none are printed.',
  'Keep text fields short and as printed. Put specific doubts in warnings, each under 15 words.',
].join('\n');

export const DISPATCH_INSTRUCTION = 'Read these dispatch screenshots into the required JSON.';

export type DispatchImage = { mime: SupportedImageMime; base64: string };

export type DispatchParams = Omit<ExtractionParams, 'output_config' | 'messages'> & {
  output_config: { effort: 'low'; format: { type: 'json_schema'; schema: Record<string, unknown> } };
  messages: Array<{
    role: 'user';
    content: Array<{ type: 'image'; source: { type: 'base64'; media_type: SupportedImageMime; data: string } } | { type: 'text'; text: string }>;
  }>;
};

/** Request body for the dispatch read: every image block first, in the order picked, then the text block. */
export function buildDispatchParams(images: DispatchImage[]): DispatchParams {
  return {
    model: RATE_CON_MODEL,
    max_tokens: 8000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: DISPATCH_SCHEMA as unknown as Record<string, unknown> } },
    system: DISPATCH_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          ...images.map((im) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: im.mime, data: im.base64 } })),
          { type: 'text' as const, text: DISPATCH_INSTRUCTION },
        ],
      },
    ],
  };
}

const objOf = (v: unknown): Record<string, unknown> => (v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * The dispatch reading in the extraction shape the app plans a load from (lib/rateCon/types.ts parseRateConExtraction), plus
 * the `dispatch` block. Broker fields are null on purpose: a dispatcher is not a broker, and Community's broker pages read them.
 */
export function dispatchToExtraction(raw: Record<string, unknown>): Record<string, unknown> {
  const disp = objOf(raw.dispatcher);
  const parsedRate = parseAmount(raw.rate).value;
  const rate = parsedRate != null && parsedRate > 0 ? parsedRate : null;
  const status = strOf(raw.status);
  const tonuOnly = raw.tonuOnly === true || (status != null && /tonu/i.test(status) && !/paid|deliver/i.test(status));
  return {
    issuedDate: null,
    broker: { name: null, mcNumber: null, dotNumber: null, phone: null, email: null },
    carrier: { name: null, mcNumber: null },
    loadNumber: strOf(raw.loadNumber),
    poNumber: null,
    stops: normalizeStops(raw.stops),
    rate: { total: rate, lineHaul: null, fuelSurcharge: null, accessorials: [] },
    paymentTermsDays: null,
    weightLbs: parseAmount(raw.weightLbs).value,
    dimensions: { lengthFt: null, widthFt: null, heightIn: null },
    commodity: strOf(raw.commodity),
    equipment: strOf(raw.equipment),
    detentionTerms: null,
    notes: strOf(raw.notes),
    milesPrinted: null,
    paymentTermsText: null,
    tonuOnly,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    dispatch: {
      dispatcherName: strOf(disp.name),
      dispatcherPhone: strOf(disp.phone),
      companyName: strOf(raw.companyName),
      rateHidden: raw.rateHidden === true && rate == null,
      status,
    },
  };
}
