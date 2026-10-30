import React from "react";
import { QuoteDesk } from "@/components/desk/quote-desk";
import { PageHead } from "@/components/desk/ui";
import { brokerNames, getQuote, getQuoteLike, listQuotes } from "@/server/tl/quote";

export const metadata = { title: "Quote a load · TrueLane" };

export default async function QuotePage({ searchParams }: { searchParams: { quote?: string; like?: string } }) {
  const id = searchParams.quote ?? null;
  const likeId = id ? null : (searchParams.like ?? null);
  const [quotes, brokers, saved, like] = await Promise.all([listQuotes(), brokerNames(), id ? getQuote(id) : null, likeId ? getQuoteLike(likeId) : null]);
  const initial = saved && id ? { id, ...saved } : like ? { id: null, values: like, vehicleId: null } : null;
  return (
    <>
      <PageHead title="Quote a load" sub="Price an offer against every truck and driver before you take it." />
      <QuoteDesk key={id ?? (likeId ? `like-${likeId}` : "new")} quotes={quotes} brokers={brokers} initial={initial} />
    </>
  );
}
