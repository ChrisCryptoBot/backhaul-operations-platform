import React from "react";
import { companyLine, type Company } from "@/lib/company";

/**
 * The top of a printed sheet (an invoice, a pay statement): who it is from on the left with the document's number, and the one figure it is
 * for on the right as the hero, with a stamp under it for where it stands. Sheets stay paper-white in both themes: they are printed and
 * saved as PDF, and a document should look the same on every screen.
 */
export function DocHead({ kicker, number, company, heroLabel, hero, sub, stamp }: { kicker: string; number: string | null; company: Company; heroLabel: string; hero: string; sub?: string; stamp?: { text: string; tone: "good" | "bad" | "plain" } }) {
  const line = companyLine(company);
  return (
    <header className="rp-head">
      <div>
        <div className="rp-kick">{kicker}</div>
        <h1>{number ?? "—"}</h1>
        <p className="rp-issuer">
          <b>{company.name}</b>
          {line ? <span>{line}</span> : null}
          {company.address ? <span style={{ whiteSpace: "pre-line" }}>{company.address}</span> : null}
        </p>
      </div>
      <div className="rp-hero">
        <div className="rp-kick">{heroLabel}</div>
        <div className="rp-big">{hero}</div>
        {sub ? <div className="rp-meta">{sub}</div> : null}
        {stamp ? <span className={`rp-stamp ${stamp.tone}`}>{stamp.text}</span> : null}
      </div>
    </header>
  );
}
