import React from "react";
import { QuoteDesk } from "@/components/desk/quote-desk";
import { PageHead } from "@/components/desk/ui";
import { brokerNames, getQuote, listQuotes } from "@/server/tl/quote";

export default async function QuotePage({ searchParams }: { searchParams: { quote?: string } }) {
  const id = searchParams.quote ?? null;
  const [quotes, brokers, saved] = await Promise.all([listQuotes(), brokerNames(), id ? getQuote(id) : null]);
  return (
    <>
      <PageHead title="Quote a load" sub="Price an offer before you take it. Every truck and driver is judged on it with the same maths the phone uses, and nothing is saved until you save the quote or book it." />
      <QuoteDesk key={id ?? "new"} quotes={quotes} brokers={brokers} initial={saved && id ? { id, ...saved } : null} />
    </>
  );
}
