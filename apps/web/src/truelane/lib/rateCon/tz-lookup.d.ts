// VENDORED from TrueLane lib/rateCon/tz-lookup.d.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
declare module 'tz-lookup' {
  /** The IANA timezone name at a latitude and longitude. Throws for an out-of-range coordinate. */
  export default function tzlookup(lat: number, lng: number): string;
}
