# TrueLane Foundational Dispatch Desk: Financial Glossary

Every number on the TrueLane Dispatch Desk has exactly one canonical name. Real dispatchers and fleet owners rely on these figures to decide whether to accept, negotiate, or reject loads. These terms are used consistently across the Fleet Matrix, Verdict Card, Copy Brief, and KPI Reports.

| Canonical Term | Definition | Formula / Origin | Appears In |
|---|---|---|---|
| **Floor** (`$/mi`) | What a mile costs to run this specific truck, derived from its audited cost profile (fuel, fixed expenses, maintenance, and driver labor). Right of the floor makes money; left of it loses money. | From audited `truckCostPerMile` + fuel + driver pay | Matrix (`floor $X.XX/mi`), Verdict Card Ruler & Facts |
| **All-In** (`$/mi`) | Total load revenue including fuel surcharge divided by every mile driven (pickup deadhead + loaded miles + return deadhead). | `effectiveGross / totalMiles` | Matrix (`All-In $/mi`), Verdict Card Headline & Ruler, Copy Brief |
| **Load Rate** (`$`) | The base gross offer for hauling the load before fuel surcharge, fees, or deductions. | Form Offer input | Deal Form, Counter-Offer Stepper, Copy Brief |
| **Load Rate After Fees** (`$`) | Net revenue retained after deductions: carrier cut, factoring fee, and cargo/liability insurance rider. | `gross - carrierFee - factoringFee - rider` | Verdict Card Facts / Fee Breakdown |
| **Margin** (`$/mi`) | What each mile clears above the truck's operating floor. Positive when profitable; negative (shortfall) when under floor. | `allInPerMile - floorPerMile` | Matrix (`Margin $/mi`), Verdict Card Sentence & Ruler, Copy Brief |
| **Left Over** (`$`) | Total dollars earned on the entire trip after all operating costs are covered. Negative when the load loses money. | `marginPerMile * totalMiles` | Matrix (`Left Over`), Verdict Card Sentence & Facts |

## Rules of Usage
1. **Never conflate Floor with All-In:** All-in is revenue per total mile; Floor is cost per total mile.
2. **Never hide empty miles in All-In:** Every mile driven (loaded and deadhead) is counted in the divisor.
3. **No ambiguous labels:** Avoid terms like "take home", "pocket rate", "net RPM", or "cushion" in production UI. Use the canonical terms above.
