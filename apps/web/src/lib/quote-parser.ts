export type ParsedBrokerSnippet = {
  origin?: string;
  destination?: string;
  offer?: string;
  weightLbs?: string;
  trailer?: string;
  brokerMc?: string;
  loadNumber?: string;
  poNumber?: string;
  notes?: string;
};

/**
 * Parses raw broker text from an email, load board (DAT/Truckstop), or chat snippet
 * into structured Quote form fields.
 */
export function parseBrokerSnippet(text: string): ParsedBrokerSnippet {
  const result: ParsedBrokerSnippet = {};
  if (!text || typeof text !== "string") return result;

  const clean = text.replace(/\r\n/g, "\n").trim();

  // 1. Origin & Destination
  // e.g. "Dallas, TX to Atlanta, GA" or "Chicago, IL -> Indianapolis, IN" or "PU: Houston, TX DEL: Memphis, TN"
  const routePatterns = [
    /(?:from|origin|pu|pickup)?[:\s]*([A-Za-z\s\.\-]+,\s*[A-Za-z]{2})\s*(?:to|->|-->|–|-|(?:dest|destination|del|delivery)[:\s]+)\s*([A-Za-z\s\.\-]+,\s*[A-Za-z]{2})/i,
    /([A-Za-z\s\.\-]+,\s*[A-Z]{2})\s+(?:to|->|-->|–)\s+([A-Za-z\s\.\-]+,\s*[A-Z]{2})/i
  ];

  for (const pat of routePatterns) {
    const m = clean.match(pat);
    if (m && m[1] && m[2]) {
      result.origin = m[1].replace(/^(from|origin|pu|pickup)[:\s]*/i, "").trim();
      result.destination = m[2].replace(/^(to|dest|destination|del|delivery)[:\s]*/i, "").trim();
      break;
    }
  }

  // 2. Offer / Pay / Rate
  // e.g. "$1,850", "Rate: $2200", "Paying $1800 all in", "Pay: 2400"
  const rateMatch = clean.match(/(?:rate|pay|paying|offer|all\s*in)?[:\s]*\$([0-9,]+(?:\.[0-9]{2})?)/i)
    || clean.match(/(?:rate|pay|paying|offer|all\s*in)[:\s]+([0-9,]+(?:\.[0-9]{2})?)/i);
  if (rateMatch && rateMatch[1]) {
    const rawVal = rateMatch[1].replace(/,/g, "");
    if (!isNaN(Number(rawVal)) && Number(rawVal) > 0) {
      result.offer = rawVal;
    }
  }

  // 3. Weight
  // e.g. "42k", "42k lbs", "42,000 lbs", "38000#", "Weight: 15000"
  const kWeight = clean.match(/(?:weight|wt)?[:\s]*([0-9]{1,2}(?:\.[0-9]+)?)\s*k\b(?:\s*(?:lbs?|#))?/i);
  if (kWeight && kWeight[1]) {
    const num = Math.round(parseFloat(kWeight[1]) * 1000);
    result.weightLbs = String(num);
  } else {
    const lbsWeight = clean.match(/(?:weight|wt)?[:\s]*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,5})\s*(?:lbs?|#|pounds)?/i);
    if (lbsWeight && lbsWeight[1]) {
      result.weightLbs = lbsWeight[1].replace(/,/g, "");
    }
  }

  // 4. Trailer type
  if (/reefer|refrigerated|temp\s*control/i.test(clean)) {
    result.trailer = "reefer";
  } else if (/flat\s*bed|flatbed/i.test(clean)) {
    result.trailer = "flatbed";
  } else if (/step\s*deck|stepdeck/i.test(clean)) {
    result.trailer = "step_deck";
  } else if (/box\s*truck|straight\s*truck/i.test(clean)) {
    result.trailer = "box_truck";
  } else if (/power\s*only/i.test(clean)) {
    result.trailer = "power_only";
  } else if (/dry\s*van|\bvan\b/i.test(clean)) {
    result.trailer = "dry_van";
  }

  // 5. MC Number
  // e.g. "MC# 123456", "MC 987654", "MC: 1234567"
  const mcMatch = clean.match(/\bMC[:\s#]*([0-9]{4,8})\b/i);
  if (mcMatch && mcMatch[1]) {
    result.brokerMc = mcMatch[1];
  }

  // 6. PO Number / Load Number
  const poMatch = clean.match(/\b(?:PO|PO#|P\.O\.)[:\s#]*([A-Za-z0-9\-]+)\b/i);
  if (poMatch && poMatch[1]) {
    result.poNumber = poMatch[1];
  }

  const loadMatch = clean.match(/\b(?:Load|Load#|Ref|Ref#|Order#)[:\s#]*([A-Za-z0-9\-]+)\b/i);
  if (loadMatch && loadMatch[1] && loadMatch[1].toUpperCase() !== result.poNumber?.toUpperCase()) {
    result.loadNumber = loadMatch[1];
  }

  return result;
}
