import React from "react";
import { QuoteDesk } from "@/components/desk/quote-desk";
import { PageHead } from "@/components/desk/ui";
import { requirePage } from "@/server/tl/access";
import { roleAtLeast } from "@/lib/roles";
import { brokerNames, getQuote, getQuoteLike, listQuotes } from "@/server/tl/quote";

export const metadata = { title: "Quote a load · TrueLane" };

/** A query value that may arrive as a list (`?quote=a&quote=b`): the first. */
const first = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function QuotePage({ searchParams }: { searchParams: { quote?: string | string[]; like?: string | string[] } }) {
  // A viewer can price a quote but not save, book or pass on it: the page says so instead of failing when they try.
  const me = await requirePage("viewer");
  const id = first(searchParams.quote);
  const likeId = id ? null : first(searchParams.like);
  const [quotes, brokers, saved, like] = await Promise.all([listQuotes(undefined, { status: "open" }), brokerNames(), id ? getQuote(id) : null, likeId ? getQuoteLike(likeId) : null]);
  const initial = saved && id ? { id, ...saved } : like ? { id: null, values: like, vehicleId: null, passedFor: null } : null;
  return (
    <>
      <PageHead title="Quote a load" sub="Price an offer against every truck and driver before you take it." />
      {id && !saved ? (
        <p className="tl-note warn" role="status">
          That quote is not here any more: it was booked, thrown away, or the link is old. Look for a booked one on the board.
        </p>
      ) : null}
      <QuoteDesk key={id ?? (likeId ? `like-${likeId}` : "new")} quotes={quotes} brokers={brokers} initial={initial} canWrite={roleAtLeast(me.role, "dispatcher")} />
    </>
  );
}
