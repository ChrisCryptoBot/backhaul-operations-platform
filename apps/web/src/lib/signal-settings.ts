import type { AlertLevel } from "./alerts";

/**
 * What the desk tells people about, and when the weekly report goes. Each is optional in the database (null = the default below), so a desk works with no setup, and nothing at all is sent until a
 * channel is configured on the server (server/notify). Pure: the Rules tab checks input with `validateSignalSettings`, and the same function guards the save.
 */
export type SignalSettings = {
  /** Tell people about this level and everything more severe: "block" is only what must be fixed before a load goes out. */
  minLevel: AlertLevel;
  /** The weekly report: whether it goes, on which weekday (0 = Sunday), and from which hour of the carrier's day. */
  reportEnabled: boolean;
  reportDay: number;
  reportHour: number;
};

export const SIGNAL_DEFAULTS: SignalSettings = { minLevel: "block", reportEnabled: true, reportDay: 1, reportHour: 7 };

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const LEVEL_CHOICES: ReadonlyArray<{ key: AlertLevel; label: string; note: string }> = [
  { key: "block", label: "Block only", note: "What must be fixed before a load goes out." },
  { key: "warn", label: "Block and warn", note: "Plus what to look at soon." },
  { key: "info", label: "Everything", note: "Plus the for-your-information notes." }
];

/** What is stored: a value, or null meaning "use the default". */
export type SignalSettingsRow = { minLevel?: string | null; reportEnabled?: boolean | null; reportDay?: number | null; reportHour?: number | null };

const isLevel = (v: unknown): v is AlertLevel => v === "block" || v === "warn" || v === "info";

export function resolveSignalSettings(row: SignalSettingsRow | null | undefined): SignalSettings {
  return {
    minLevel: isLevel(row?.minLevel) ? row!.minLevel : SIGNAL_DEFAULTS.minLevel,
    reportEnabled: typeof row?.reportEnabled === "boolean" ? row.reportEnabled : SIGNAL_DEFAULTS.reportEnabled,
    reportDay: Number.isInteger(row?.reportDay) && row!.reportDay! >= 0 && row!.reportDay! <= 6 ? row!.reportDay! : SIGNAL_DEFAULTS.reportDay,
    reportHour: Number.isInteger(row?.reportHour) && row!.reportHour! >= 0 && row!.reportHour! <= 23 ? row!.reportHour! : SIGNAL_DEFAULTS.reportHour
  };
}

export type SignalSettingsCheck = { ok: true; stored: Required<SignalSettingsRow>; resolved: SignalSettings } | { ok: false; errors: Partial<Record<keyof SignalSettings, string>> };

/** Checks what the form sent. A blank field means "use the default" and is stored as null. */
export function validateSignalSettings(input: Record<string, unknown>): SignalSettingsCheck {
  const errors: Partial<Record<keyof SignalSettings, string>> = {};
  const blank = (v: unknown) => v == null || (typeof v === "string" && v.trim() === "");
  const stored: Required<SignalSettingsRow> = { minLevel: null, reportEnabled: null, reportDay: null, reportHour: null };

  if (!blank(input.minLevel)) {
    if (isLevel(input.minLevel)) stored.minLevel = input.minLevel;
    else errors.minLevel = "Pick block only, block and warn, or everything.";
  }
  if (!blank(input.reportEnabled)) {
    const v = input.reportEnabled;
    if (v === true || v === "true" || v === "on" || v === "yes") stored.reportEnabled = true;
    else if (v === false || v === "false" || v === "off" || v === "no") stored.reportEnabled = false;
    else errors.reportEnabled = "Choose whether the weekly report goes.";
  }
  const whole = (key: "reportDay" | "reportHour", min: number, max: number, what: string) => {
    if (blank(input[key])) return;
    const n = typeof input[key] === "number" ? (input[key] as number) : Number.parseInt(String(input[key]).trim(), 10);
    if (!Number.isInteger(n) || String(input[key]).trim() !== String(n)) errors[key] = `${what}: a whole number.`;
    else if (n < min || n > max) errors[key] = `${what}: between ${min} and ${max}.`;
    else stored[key] = n;
  };
  whole("reportDay", 0, 6, "Weekday");
  whole("reportHour", 0, 23, "Hour");
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, stored, resolved: resolveSignalSettings(stored) };
}

/** "7 AM", "12 PM". */
export function hourLabel(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/** "Monday at 7 AM". */
export function reportWhen(s: Pick<SignalSettings, "reportDay" | "reportHour">): string {
  return `${WEEKDAYS[s.reportDay]} at ${hourLabel(s.reportHour)}`;
}
