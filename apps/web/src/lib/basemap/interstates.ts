/**
 * The interstate corridors freight moves on, as simple polylines through the cities each one connects ([longitude, latitude]). Authored for the radar's bundled basemap: no tile server, no key,
 * no network. They are a map of where the big lanes run, not a road database, and nothing prices or routes from them.
 */
type Pt = [number, number];
const C: Record<string, Pt> = {
  LA: [-118.24, 34.05], PHX: [-112.07, 33.45], TUS: [-110.97, 32.22], ELP: [-106.49, 31.76], SAT: [-98.49, 29.42], HOU: [-95.37, 29.76], NOL: [-90.07, 29.95], MOB: [-88.04, 30.69], TLH: [-84.28, 30.44], JAX: [-81.66, 30.33],
  PEC: [-103.49, 31.42], MAF: [-102.08, 32.0], ABI: [-99.73, 32.45], FTW: [-97.33, 32.75], DAL: [-96.8, 32.78], SHV: [-93.75, 32.52], JAN: [-90.18, 32.3], BHM: [-86.8, 33.52], ATL: [-84.39, 33.75], CAE: [-81.03, 34.0],
  LRD: [-99.5, 27.5], AUS: [-97.74, 30.27], WAC: [-97.15, 31.55], OKC: [-97.52, 35.47], ICT: [-97.34, 37.69], MCI: [-94.58, 39.1], DSM: [-93.62, 41.59], MSP: [-93.27, 44.98],
  BAR: [-117.02, 34.9], FLG: [-111.65, 35.2], ABQ: [-106.65, 35.08], AMA: [-101.83, 35.22], LIT: [-92.29, 34.75], MEM: [-90.05, 35.15], BNA: [-86.78, 36.16], TYS: [-83.92, 35.96], AVL: [-82.55, 35.6], RDU: [-78.64, 35.78], ILM: [-77.94, 34.23],
  DEN: [-104.99, 39.74], SLN: [-97.61, 38.84], STL: [-90.2, 38.63], IND: [-86.16, 39.77], CMH: [-83.0, 39.96], PIT: [-80.0, 40.44], BAL: [-76.61, 39.29],
  SFO: [-122.42, 37.77], SAC: [-121.49, 38.58], RNO: [-119.81, 39.53], SLC: [-111.89, 40.76], CYS: [-104.82, 41.14], OMA: [-95.93, 41.26], CHI: [-87.63, 41.88], CLE: [-81.69, 41.5], EWR: [-74.17, 40.73],
  SEA: [-122.33, 47.61], GEG: [-117.43, 47.66], BIL: [-108.5, 45.78], FSD: [-96.73, 43.55], MSN: [-89.4, 43.07], BUF: [-78.88, 42.89], BOS: [-71.06, 42.36],
  MIA: [-80.19, 25.76], SAV: [-81.09, 32.08], CHS: [-79.93, 32.78], FAY: [-78.88, 35.05], RIC: [-77.43, 37.54], DCA: [-77.04, 38.9], PHL: [-75.17, 39.95], NYC: [-74.0, 40.71],
  TPA: [-82.46, 27.95], CHA: [-85.31, 35.05], LEX: [-84.5, 38.04], CVG: [-84.51, 39.1], TOL: [-83.54, 41.65], DTW: [-83.05, 42.33],
  MGM: [-86.3, 32.37], SDL: [-85.76, 38.25], SAN: [-117.16, 32.72], PDX: [-122.68, 45.52]
};

const line = (name: string, ...codes: string[]) => ({ name, coords: codes.map((c) => C[c]!) });

export const INTERSTATES: ReadonlyArray<{ name: string; coords: Pt[] }> = [
  line("I-5", "SAN", "LA", "SAC", "PDX", "SEA"),
  line("I-10", "LA", "PHX", "TUS", "ELP", "SAT", "HOU", "NOL", "MOB", "TLH", "JAX"),
  line("I-20", "PEC", "MAF", "ABI", "FTW", "DAL", "SHV", "JAN", "BHM", "ATL", "CAE"),
  line("I-35", "LRD", "SAT", "AUS", "WAC", "DAL", "OKC", "ICT", "MCI", "DSM", "MSP"),
  line("I-40", "BAR", "FLG", "ABQ", "AMA", "OKC", "LIT", "MEM", "BNA", "TYS", "AVL", "RDU", "ILM"),
  line("I-55", "NOL", "JAN", "MEM", "STL", "CHI"),
  line("I-65", "MOB", "MGM", "BHM", "BNA", "SDL", "IND", "CHI"),
  line("I-70", "DEN", "SLN", "MCI", "STL", "IND", "CMH", "PIT", "BAL"),
  line("I-75", "MIA", "TPA", "ATL", "CHA", "TYS", "LEX", "CVG", "TOL", "DTW"),
  line("I-80", "SFO", "SAC", "RNO", "SLC", "CYS", "OMA", "DSM", "CHI", "CLE", "EWR"),
  line("I-90", "SEA", "GEG", "BIL", "FSD", "MSN", "CHI", "CLE", "BUF", "BOS"),
  line("I-95", "MIA", "JAX", "SAV", "CHS", "FAY", "RIC", "DCA", "BAL", "PHL", "NYC", "BOS")
];
