/**
 * A driver's code: the first letter of the first name and the first three letters of the last name, in capitals (John Smith is JSMI). A second driver who comes to the same code takes
 * a number on the end (JSMI2, JSMI3); the first keeps the plain one. Accents and punctuation are dropped (O'Neil is ONEI, Zoë Núñez is ZNUN), a last name shorter than three letters
 * uses what it has (Jo Li is JLI), and the last name is the last word that is not a suffix (Jr, Sr, II, III, IV). A name with one word takes its first four letters. Pure.
 */
const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V"]);

const letters = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();

/** The code before any number is added: "JSMI". Empty when the name has no letters at all. */
export function driverCodeBase(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => ({ raw: w, letters: letters(w) }))
    .filter((w) => w.letters.length > 0);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.letters.slice(0, 4);
  const first = words[0]!;
  // The last word that is not a suffix; a name of nothing but suffixes falls back to its last word.
  const body = words.slice(1);
  const lastWord = [...body].reverse().find((w) => !SUFFIXES.has(w.letters)) ?? body[body.length - 1]!;
  return first.letters.slice(0, 1) + lastWord.letters.slice(0, 3);
}

/** The next free code for this name given the codes already taken (upper case). The first holder keeps the plain code; the next gets 2, then 3. */
export function nextDriverCode(name: string, taken: ReadonlySet<string>): string {
  const base = driverCodeBase(name) || "DRV";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A code as a person may type it: trimmed, capitals, letters and digits only, up to eight characters. Empty when nothing usable is left. */
export function cleanDriverCode(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}
