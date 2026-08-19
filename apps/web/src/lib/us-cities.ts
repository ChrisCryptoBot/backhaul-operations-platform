// Bundled US city/state dataset for local, offline autocomplete — no Mapbox/Places
// API needed. Curated to cover every state's major metros plus the Northeast freight
// corridor this desk actually books (Leesport-hub lanes). Expand freely; the search is
// a simple prefix/substring match, so more rows just means more coverage.
//
// Format: "City|ST". Kept compact so the whole set ships in the client bundle.

const RAW_CITIES = [
  // ── Northeast freight corridor (the desk's real lanes) ──
  "Leesport|PA", "Reading|PA", "Allentown|PA", "Bethlehem|PA", "Ancient Oaks|PA", "Scranton|PA",
  "Wilkes-Barre|PA", "Warrendale|PA", "Pittsburgh|PA", "Harrisburg|PA", "Lancaster|PA", "York|PA",
  "Philadelphia|PA", "Chambersburg|PA", "Carlisle|PA", "Hazleton|PA", "Williamsport|PA", "Erie|PA",
  "Hermon|ME", "Bangor|ME", "Portland|ME", "Lewiston|ME", "Augusta|ME",
  "Holland|MA", "Worcester|MA", "Boston|MA", "Springfield|MA", "Norwood|MA", "Chicopee|MA", "Taunton|MA",
  "Baldwinsville|NY", "Syracuse|NY", "Jamestown|NY", "Buffalo|NY", "Rochester|NY", "Albany|NY",
  "Binghamton|NY", "Utica|NY", "Watertown|NY", "New York|NY", "Yonkers|NY",
  "Advance|NC", "Winston-Salem|NC", "Greensboro|NC", "Charlotte|NC", "Raleigh|NC", "Durham|NC",
  "Newark|NJ", "Elizabeth|NJ", "Edison|NJ", "Trenton|NJ", "Secaucus|NJ", "Cranbury|NJ",
  "Baltimore|MD", "Hagerstown|MD", "Jessup|MD", "Elkton|MD",
  "Wilmington|DE", "New Castle|DE",
  "Hartford|CT", "New Haven|CT", "Bridgeport|CT", "Waterbury|CT",
  "Providence|RI", "Manchester|NH", "Nashua|NH", "Burlington|VT",
  "Richmond|VA", "Norfolk|VA", "Roanoke|VA", "Front Royal|VA",
  // ── National major metros (broad coverage for spot lanes) ──
  "Atlanta|GA", "Savannah|GA", "Columbus|GA", "Macon|GA",
  "Miami|FL", "Orlando|FL", "Tampa|FL", "Jacksonville|FL", "Lakeland|FL", "Fort Lauderdale|FL",
  "Charleston|SC", "Columbia|SC", "Greenville|SC", "Spartanburg|SC",
  "Nashville|TN", "Memphis|TN", "Knoxville|TN", "Chattanooga|TN",
  "Birmingham|AL", "Montgomery|AL", "Mobile|AL", "Huntsville|AL",
  "Jackson|MS", "New Orleans|LA", "Baton Rouge|LA", "Shreveport|LA",
  "Little Rock|AR", "Louisville|KY", "Lexington|KY", "Bowling Green|KY",
  "Columbus|OH", "Cleveland|OH", "Cincinnati|OH", "Toledo|OH", "Akron|OH", "Dayton|OH",
  "Detroit|MI", "Grand Rapids|MI", "Lansing|MI", "Flint|MI", "Warren|MI",
  "Indianapolis|IN", "Fort Wayne|IN", "Evansville|IN", "South Bend|IN",
  "Chicago|IL", "Rockford|IL", "Peoria|IL", "Springfield|IL", "Joliet|IL", "Naperville|IL",
  "Milwaukee|WI", "Madison|WI", "Green Bay|WI", "Kenosha|WI",
  "Minneapolis|MN", "Saint Paul|MN", "Rochester|MN", "Duluth|MN",
  "Des Moines|IA", "Cedar Rapids|IA", "Davenport|IA",
  "Kansas City|MO", "Saint Louis|MO", "Springfield|MO", "Columbia|MO",
  "Omaha|NE", "Lincoln|NE", "Wichita|KS", "Topeka|KS", "Kansas City|KS",
  "Oklahoma City|OK", "Tulsa|OK",
  "Dallas|TX", "Fort Worth|TX", "Houston|TX", "San Antonio|TX", "Austin|TX", "El Paso|TX",
  "Laredo|TX", "Lubbock|TX", "Amarillo|TX", "Corpus Christi|TX", "McAllen|TX",
  "Denver|CO", "Colorado Springs|CO", "Aurora|CO", "Pueblo|CO",
  "Albuquerque|NM", "Santa Fe|NM", "Las Cruces|NM",
  "Phoenix|AZ", "Tucson|AZ", "Mesa|AZ", "Flagstaff|AZ",
  "Salt Lake City|UT", "Ogden|UT", "Provo|UT",
  "Las Vegas|NV", "Reno|NV", "Boise|ID",
  "Los Angeles|CA", "San Diego|CA", "San Francisco|CA", "San Jose|CA", "Sacramento|CA",
  "Fresno|CA", "Oakland|CA", "Long Beach|CA", "Bakersfield|CA", "Ontario|CA", "Stockton|CA",
  "Riverside|CA", "Fontana|CA",
  "Portland|OR", "Salem|OR", "Eugene|OR",
  "Seattle|WA", "Spokane|WA", "Tacoma|WA", "Vancouver|WA",
  "Billings|MT", "Fargo|ND", "Sioux Falls|SD", "Cheyenne|WY",
  "Charleston|WV", "Morgantown|WV", "Huntington|WV",
  "Washington|DC"
];

export interface CitySuggestion {
  city: string;
  state: string;
  /** "City, ST" for display. */
  label: string;
}

const CITIES: CitySuggestion[] = RAW_CITIES.map((row) => {
  const [city, state] = row.split("|");
  return { city, state, label: `${city}, ${state}` };
});

/**
 * Prefix-first, then substring city search. Prefix matches rank above substring
 * matches so typing "phi" surfaces Philadelphia before anything containing "phi".
 */
export function searchCities(query: string, limit = 8): CitySuggestion[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const prefix: CitySuggestion[] = [];
  const substr: CitySuggestion[] = [];
  for (const c of CITIES) {
    const name = c.city.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) substr.push(c);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...substr].slice(0, limit);
}
