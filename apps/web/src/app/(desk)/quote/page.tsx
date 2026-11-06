import { terminalFilter } from "@/lib/scope";
import { currentTerminal } from "@/server/tl/terminal";
import React from "react";
import { QuoteDesk, type FleetTruckOption } from "@/components/desk/quote-desk";
import { PageHead } from "@/components/desk/ui";
import { requirePage } from "@/server/tl/access";
import { can } from "@/lib/roles";
import { brokerNames, getQuote, getQuoteLike, listOpenPickups, listQuotes } from "@/server/tl/quote";
import { prisma } from "@/lib/db";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const metadata = { title: "Quote a load · TrueLane" };

/** A query value that may arrive as a list (`?quote=a&quote=b`): the first. */
const first = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export default async function QuotePage({ searchParams }: { searchParams: { quote?: string | string[]; like?: string | string[] } }) {
  // A viewer can price a quote but not save, book or pass on it: the page says so instead of failing when they try.
  const me = await requirePage("read");
  const id = first(searchParams.quote);
  const likeId = id ? null : first(searchParams.like);
  // Everything on this page is for the terminals in view (inside what the person may see).
  const terminal = await currentTerminal();
  const [quotes, brokers, saved, like, fleetRaw, openPickups] = await Promise.all([
    listQuotes(undefined, { status: "open" }, terminal),
    brokerNames(undefined, terminal),
    id ? getQuote(id) : null,
    likeId ? getQuoteLike(likeId) : null,
    prisma.vehicle.findMany({
      where: { workspaceId: currentWorkspaceId(), archivedAt: null, ...(terminal != null ? { terminal: terminalFilter(terminal) } : {}) },
      include: {
        costProfile: true,
        drivers: { where: { active: true }, orderBy: { name: "asc" } }
      },
      orderBy: { name: "asc" }
    }),
    listOpenPickups(undefined, terminal)
  ]);

  const fleet: FleetTruckOption[] = fleetRaw.map((v) => ({
    id: v.id,
    name: v.name ?? "Unnamed truck",
    type: v.type,
    terminal: v.terminal,
    homeBaseAddress: v.homeBaseAddress,
    hasCostProfile: !!v.costProfile,
    drivers: v.drivers.map((d) => ({ id: d.id, name: d.name }))
  }));

  const initial = saved && id ? { id, ...saved } : like ? { id: null, values: like, vehicleId: null, passedFor: null } : null;
  // Names the form for what it keeps: each quote is its own, and each "quote like this" is its own (they start from different loads).
  const draftId = id ?? (likeId ? `like-${likeId}` : "new");
  return (
    <>
      <PageHead title="Quote a load" sub="Price an offer against every truck and driver before you accept it." />
      {id && !saved ? (
        <p className="tl-note warn" role="status">
          That quote is not here any more: it was booked, thrown away, or the link is old. Look for a booked one on the board.
        </p>
      ) : null}
      <QuoteDesk
        key={draftId}
        draftId={draftId}
        quotes={quotes}
        brokers={brokers}
        initial={initial}
        canWrite={can(me.role, me.grants, "quote")}
        fleet={fleet}
        openPickups={openPickups}
      />
    </>
  );
}
