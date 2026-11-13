/**
 * Where an outbound webhook may be sent (docs/MONEY_PLAN.md, Wave 7 step 3). Pure: no DNS, no network. The server resolves the name, hands every answer here, and connects only to an address
 * this file allowed, pinned for the connection (src/server/webhooks/transport.ts), with redirects not followed. Nothing here is switched by an environment flag except whether plain http is
 * accepted outside production; the address rules hold everywhere, and tests pass their own resolver instead of opening private addresses.
 *
 * Refused: credentials in the address, anything but http(s), plain http in production, and any address that is loopback, private, link-local (which holds the cloud metadata address
 * 169.254.169.254), carrier-grade NAT, multicast, reserved, documentation or benchmarking space, in IPv4 or IPv6, including IPv4 written inside IPv6 (::ffff:127.0.0.1, 64:ff9b::/96 NAT64,
 * 2002::/16 6to4), whose embedded IPv4 address is judged by the IPv4 rules.
 */
export type UrlCheck = { ok: true; url: URL; host: string; literal: string | null } | { ok: false; error: string };

export const MAX_URL_LENGTH = 500;

export function checkUrl(raw: string, opts: { production: boolean }): UrlCheck {
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_URL_LENGTH) return { ok: false, error: "Give the full address of the receiver, like https://hooks.example.com/truelane." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That is not a web address." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "The address must start with https://." };
  if (opts.production && url.protocol !== "https:") return { ok: false, error: "The address must start with https:// (plain http is not sent anywhere)." };
  if (url.username || url.password) return { ok: false, error: "Leave the user name and password out of the address: the receiver checks the signature instead." };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return { ok: false, error: "The address has no host." };
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return { ok: false, error: "That address points inside a private network." };
  const literal = parseIpv4(host) ? host : parseIpv6(host) ? host : null;
  if (literal && isBlockedIp(literal)) return { ok: false, error: "That address points inside a private network." };
  return { ok: true, url, host, literal };
}

/** Every address a name resolved to must be allowed: one private answer refuses the lot (a name that answers both is exactly how rebinding is tried). */
export function checkAddresses(addresses: ReadonlyArray<{ address: string; family: number }>): { ok: true; address: string; family: 4 | 6 } | { ok: false; error: string } {
  if (addresses.length === 0) return { ok: false, error: "The receiver's name does not resolve." };
  for (const a of addresses) {
    if (isBlockedIp(a.address)) return { ok: false, error: "The receiver's name points inside a private network." };
  }
  const first = addresses[0]!;
  return { ok: true, address: first.address, family: first.family === 6 ? 6 : 4 };
}

export function parseIpv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map((p) => Number.parseInt(p, 10));
  if (parts.some((p, i) => p > 255 || (m[i + 1]!.length > 1 && m[i + 1]!.startsWith("0")))) return null;
  return parts;
}

/** Eight 16-bit groups, or null. Accepts :: and a dotted IPv4 tail (::ffff:127.0.0.1); a zone (%eth0) is refused. */
export function parseIpv6(text: string): number[] | null {
  if (!text.includes(":") || text.includes("%")) return null;
  let s = text.toLowerCase();
  let tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const v4 = parseIpv4(dotted[2]!);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part === "" ? [] : part.split(":"));
  const head = read(halves[0]!);
  const rest = halves.length === 2 ? read(halves[1]!) : [];
  const groups = [...head, ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const nums = (gs: string[]) => gs.map((g) => Number.parseInt(g, 16));
  const total = head.length + rest.length + tail.length;
  if (halves.length === 1) return total === 8 ? [...nums(head), ...tail] : null;
  if (total > 7) return null;
  return [...nums(head), ...Array<number>(8 - total).fill(0), ...nums(rest), ...tail];
}

const inV4 = (ip: number[], base: number[], bits: number): boolean => {
  const n = (a: number[]) => ((a[0]! << 24) >>> 0) + (a[1]! << 16) + (a[2]! << 8) + a[3]!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((n(ip) & mask) >>> 0) === ((n(base) & mask) >>> 0);
};

const V4_BLOCKED: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT (also 100.100.100.200, a cloud metadata address)
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, cloud metadata 169.254.169.254
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4] // reserved, and 255.255.255.255
];

function v4Blocked(ip: number[]): boolean {
  return V4_BLOCKED.some(([base, bits]) => inV4(ip, base, bits));
}

/** Whether an address (IPv4 or IPv6 text) is one a webhook may never reach. Text that is not an address is blocked. */
export function isBlockedIp(text: string): boolean {
  const v4 = parseIpv4(text);
  if (v4) return v4Blocked(v4);
  const g = parseIpv6(text);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && g[7] === 1) return true; // ::1
  if (allZero(0, 5) && g[5] === 0xffff) return v4Blocked(embedded(g[6]!, g[7]!)); // ::ffff:a.b.c.d, IPv4-mapped
  if (allZero(0, 6)) return true; // ::a.b.c.d, IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return v4Blocked(embedded(g[6]!, g[7]!)); // 64:ff9b::/96, NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48, local NAT64
  if (g[0] === 0x2002) return v4Blocked(embedded(g[1]!, g[2]!)); // 2002::/16, 6to4
  const top = g[0]!;
  if ((top & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (fd00:ec2::254, a metadata address)
  if ((top & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((top & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((top & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (top === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (top === 0x2001 && g[1]! < 0x0200) return true; // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID)
  if (top === 0x0100 && allZero(1, 4)) return true; // 100::/64 discard
  return false;
}
