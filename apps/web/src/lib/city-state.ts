/** "2300 Irving Blvd, Dallas, TX 75207" -> "Dallas, TX". Falls back to the text as printed. Pure, so a screen can use it without the server's code. */
export function cityState(address: string | null): string | null {
  if (!address) return null;
  const m = /([^,]+),\s*([A-Z]{2})\b/.exec(address.split(",").slice(-2).join(","));
  return m ? `${m[1]!.trim()}, ${m[2]}` : address;
}
