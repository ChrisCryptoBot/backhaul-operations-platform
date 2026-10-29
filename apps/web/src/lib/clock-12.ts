/** "13:05" -> "1:05 PM", "00:30" -> "12:30 AM". Null for anything that is not a 24-hour time. Pure. */
export function twelveHour(hm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return null;
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}
