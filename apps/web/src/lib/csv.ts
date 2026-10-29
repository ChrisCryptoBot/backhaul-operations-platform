/**
 * CSV for the desk's exports. Excel-friendly (a byte order mark and CRLF line ends), and safe to open: a text cell that
 * starts with = + - @ or a tab would be run as a formula by a spreadsheet, so it gets a leading apostrophe. Numbers are
 * written as numbers, so a negative amount is not mistaken for text.
 */
export type CsvCell = string | number | boolean | null | undefined | Date;

export function csvCell(v: CsvCell): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}
