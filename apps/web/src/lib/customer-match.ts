/**
 * Close spellings of a customer's name, for the question asked before Quote makes a new customer record ("Did you mean XPO Logistics?"): a typo in a name makes a second customer, and the
 * first one's pay record, MC and terms no longer follow its loads. Pure.
 *
 * Names are compared as words: case, punctuation and the company endings that carry nothing (Inc, LLC, Co, Corp, Ltd) are set aside. A name is close when one holds the other
 * ("XPO" and "XPO Logistics"), or when it is a few letters off (an edit distance of up to 2, or 3 for names longer than twelve letters).
 */
const ENDINGS = new Set(["inc", "llc", "co", "corp", "corporation", "ltd", "company", "the"]);

export const nameKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w !== "" && !ENDINGS.has(w))
    .join(" ");

/** Letters to change, add or remove to turn one into the other. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/**
 * The names in `known` close to `name`, closest first, at most `max`. The very same name (any capitals) is the same record and is left out; the same words with an ending or punctuation
 * changed ("XPO Logistics, Inc." for "XPO Logistics") come first, as the likeliest slip.
 */
export function nearNames(name: string, known: readonly string[], max = 3): string[] {
  const k = nameKey(name);
  const exact = name.trim().toLowerCase();
  if (k.length < 2) return [];
  const scored: Array<{ name: string; d: number }> = [];
  for (const other of known) {
    const o = nameKey(other);
    if (o === "" || other.trim().toLowerCase() === exact) continue;
    const contains = o.length >= 3 && k.length >= 3 && (o.startsWith(k) || k.startsWith(o) || ` ${o} `.includes(` ${k} `) || ` ${k} `.includes(` ${o} `));
    const d = distance(k, o);
    const limit = Math.max(k.length, o.length) > 12 ? 3 : 2;
    if (contains || d <= limit) scored.push({ name: other, d: contains ? Math.min(d, 1) : d });
  }
  return scored
    .sort((a, b) => a.d - b.d || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((s) => s.name);
}

