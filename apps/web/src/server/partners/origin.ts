/**
 * This desk's own address as the person's browser sees it, for a partner's sign-in callback (the company is told where to send the person back, and checks it against the address
 * registered with it). Behind a host's proxy the forwarded headers carry it; on a laptop it is the plain host. Only a host name with an optional port is accepted.
 */
export function originOf(h: Headers): string | null {
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0]!.trim();
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const forwarded = (h.get("x-forwarded-proto") ?? "").split(",")[0]!.trim();
  const proto = forwarded === "http" || forwarded === "https" ? forwarded : local ? "http" : "https";
  return `${proto}://${host}`;
}
