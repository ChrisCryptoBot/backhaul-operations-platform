/**
 * How many pages a PDF has, counted in one byte pass (no string the size of the file), so a long file can be refused before the reading service is paid by the page.
 * The same rule as the phone backend's `pdfPageCount` (supabase/functions/rate-con-extract/core.ts); tests/pdf-pages.test.ts pins the same cases. The vendored copy of that core
 * carries it too after the next refresh (scripts/vendor-truelane.mjs), and this file can then go.
 *
 * The count is the larger of the page objects (/Type /Page, not /Pages) and the biggest /Count (the page tree's total). A PDF that hides its page tree inside compressed object streams
 * answers 0, which means "unknown", not "too many": the 10 MB cap still bounds that call.
 */
export const MAX_RATE_CON_PAGES = 12;

export function pdfPageCount(bytes: Uint8Array): number {
  const n = bytes.length;
  const isWs = (b: number | undefined) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
  const at = (i: number, word: string) => {
    for (let k = 0; k < word.length; k++) if (bytes[i + k] !== word.charCodeAt(k)) return false;
    return true;
  };
  let pages = 0;
  let biggestCount = 0;
  for (let i = 0; i < n; i++) {
    if (bytes[i] !== 0x2f) continue; // "/"
    if (at(i + 1, "Type")) {
      let j = i + 5;
      while (isWs(bytes[j])) j++;
      if (bytes[j] === 0x2f && at(j + 1, "Page") && bytes[j + 5] !== 0x73) pages++; // not "/Pages"
    } else if (at(i + 1, "Count")) {
      let j = i + 6;
      while (isWs(bytes[j])) j++;
      let v = 0;
      let digits = 0;
      for (; bytes[j] !== undefined && bytes[j]! >= 0x30 && bytes[j]! <= 0x39 && digits < 7; j++, digits++) v = v * 10 + (bytes[j]! - 0x30);
      if (digits > 0 && v > biggestCount) biggestCount = v;
    }
  }
  return Math.max(pages, biggestCount);
}
