import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { CanGate } from "@/components/desk/kit/can-gate";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead, Stat } from "@/components/desk/ui";
import { prisma } from "@/lib/db";
import { dateTime } from "@/lib/desk-format";
import { PRODUCT_LABEL, STATUS_LABEL, type FuelProduct, type FuelStatus } from "@/lib/fuel-normalize";
import { returnMoney } from "@/lib/ifta-return";
import { recentQuarters } from "@/lib/ifta-rates-csv";
import { providerName } from "@/server/partners/call";
import { iftaReturnDetail } from "@/server/partners/ifta-return";
import { requirePage } from "@/server/tl/access";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";

export const metadata = { title: "IFTA truck audit · TrueLane" };
export const dynamic = "force-dynamic";

const STATES: Column[] = [
  { key: "state", label: "Jurisdiction", group: "Where", sticky: true, width: 130 },
  { key: "miles", label: "Miles", group: "This truck", align: "num" },
  { key: "pieces", label: "Pieces", group: "This truck", align: "num" },
  { key: "paid", label: "Tax-paid gal", group: "This truck", align: "num" }
];

const PIECES: Column[] = [
  { key: "started", label: "Started", group: "When", sticky: true, width: 150 },
  { key: "ended", label: "Ended", group: "When" },
  { key: "state", label: "State", group: "Where" },
  { key: "kind", label: "Loaded", group: "Where" },
  { key: "load", label: "Load", group: "Where" },
  { key: "odoStart", label: "Start odometer", group: "Backing", align: "num" },
  { key: "odoEnd", label: "End odometer", group: "Backing", align: "num" },
  { key: "miles", label: "Miles", group: "Backing", align: "num", accentBand: true },
  { key: "id", label: "Piece id", group: "Backing", priority: 3 }
];

const RECEIPTS: Column[] = [
  { key: "at", label: "Bought", group: "When", sticky: true, width: 150 },
  { key: "receipt", label: "Receipt", group: "Receipt" },
  { key: "location", label: "Location", group: "Receipt" },
  { key: "state", label: "State", group: "Receipt" },
  { key: "product", label: "Product", group: "Receipt" },
  { key: "status", label: "Status", group: "Receipt" },
  { key: "taxPaid", label: "Tax paid", group: "Receipt" },
  { key: "gallons", label: "Gallons", group: "Money", align: "num" },
  { key: "amount", label: "Amount", group: "Money", align: "num" },
  { key: "counted", label: "On the return", group: "Money" }
];

const n1 = (s: string | null) => (s == null ? "—" : Number(s).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

/**
 * One truck's IFTA quarter, line by line (money plan Wave 5 step 7): every counted mileage piece (ELD or routed, the same rows its return figures are summed from) and every fuel receipt of the
 * quarter, counted or not and why. Read from the same call as the return screen and the audit CSV, so the state totals here are the return's.
 */
export default async function IftaTruckAuditPage({ params, searchParams }: { params: { id: string }; searchParams?: { quarter?: string } }) {
  await requirePage("read");
  const workspaceId = currentWorkspaceId();
  const truck = await prisma.vehicle.findFirst({ where: { id: params.id, workspaceId }, select: { id: true, name: true } });
  if (!truck) notFound();
  const tz = await workspaceTimezone(workspaceId);
  const options = recentQuarters(new Date(), tz);
  const quarter = options.includes(searchParams?.quarter ?? "") ? searchParams!.quarter! : options[0]!;
  const r = await iftaReturnDetail(quarter, { vehicleId: truck.id });
  if (!r.ok) throw new Error(r.error);
  const t = r.trucks.find((x) => x.vehicleId === truck.id) ?? null;
  const name = truck.name ?? "Unnamed truck";

  const piecesBy = new Map<string, number>();
  for (const p of r.pieces) piecesBy.set(p.jurisdiction, (piecesBy.get(p.jurisdiction) ?? 0) + 1);
  const paid = new Map((t?.taxPaidByState ?? []).map((x) => [x.jurisdiction, x.gallons]));
  const states = [...new Set([...(t?.milesByState ?? []).map((m) => m.jurisdiction), ...paid.keys()])].sort();
  const stateRows: Row[] = states.map((j) => ({
    id: j,
    cells: { state: <b>{j}</b>, miles: n1(t?.milesByState.find((m) => m.jurisdiction === j)?.miles ?? "0"), pieces: String(piecesBy.get(j) ?? 0), paid: paid.has(j) ? n1(paid.get(j)!) : <span className="dim">—</span> }
  }));
  const pieceRows: Row[] = r.pieces.map((p) => ({
    id: p.id,
    cells: {
      started: dateTime(p.startedAt),
      ended: dateTime(p.endedAt),
      state: <b>{p.jurisdiction}</b>,
      kind: p.loaded ? "Loaded" : <span className="dim">Empty</span>,
      load: p.loadId ? <Link href={`/loads/${p.loadId}`}>{p.loadNumber ?? "Load"}</Link> : p.loaded ? <span className="dim">Load removed</span> : <span className="dim">—</span>,
      odoStart: p.startOdometer ? n1(p.startOdometer) : <span className="dim">Routed</span>,
      odoEnd: p.endOdometer ? n1(p.endOdometer) : <span className="dim">Routed</span>,
      miles: n1(p.miles),
      id: <span className="dim">{p.externalId}</span>
    }
  }));
  const why = (f: (typeof r.receipts)[number]) =>
    f.counted ? (f.taxPaid ? "Yes, credited" : "Yes, MPG only (bulk)") : f.status !== "settled" ? `No, ${STATUS_LABEL[f.status as FuelStatus]?.toLowerCase() ?? f.status}` : f.product === "road_diesel" ? "No, no gallons" : `No, ${PRODUCT_LABEL[f.product as FuelProduct]?.toLowerCase() ?? f.product}`;
  const receiptRows: Row[] = r.receipts.map((f) => ({
    id: f.id,
    cells: {
      at: dateTime(f.at),
      receipt: (
        <>
          {f.externalId} <span className="dim">{providerName(f.provider)}</span>
        </>
      ),
      location: f.location ?? <span className="dim">—</span>,
      state: f.state ?? <span className="t-st" data-tone="bad">None</span>,
      product: PRODUCT_LABEL[f.product as FuelProduct] ?? f.product,
      status: STATUS_LABEL[f.status as FuelStatus] ?? f.status,
      taxPaid: f.taxPaid ? "Yes" : "No",
      gallons: n1(f.gallons),
      amount: returnMoney(f.amount),
      counted: f.counted ? why(f) : <span className="dim">{why(f)}</span>
    }
  }));

  return (
    <>
      <PageHead title={`${name}: IFTA ${quarter}`} sub="Every mile and every fuel receipt behind this truck's part of the return.">
        <Link className="tl-btn" href={`/ifta?quarter=${quarter}`}>Back to the return</Link>
        <CanGate caps={["bill"]}>
          <a className="tl-btn" href={`/export/ifta-audit?quarter=${quarter}&truck=${truck.id}`}>Audit CSV</a>
        </CanGate>
      </PageHead>
      <div className="tl-tabs ifta-tabs" role="tablist" aria-label="Quarter">
        {options.map((o) => (
          <Link key={o} href={`/ifta/trucks/${truck.id}?quarter=${o}`} className="tl-tab" aria-current={o === quarter ? "true" : undefined}>
            {o}
          </Link>
        ))}
      </div>
      <div className="tl-grid cols-4">
        <Stat label="Miles" value={t ? n1(t.miles) : "—"} sub={t?.method ? `${t.method === "eld" ? "ELD" : "Routed"} (${providerName(t.source ?? "")})` : "No miles this quarter"} />
        <Stat label="Road diesel" value={t ? `${n1(t.gallons)} gal` : "—"} sub={t && Number(t.bulkGallons) > 0 ? `${n1(t.bulkGallons)} gal of it bulk` : undefined} />
        <Stat label="Own MPG" value={t?.mpg ?? "—"} sub={r.mpg ? `Fleet ${r.mpg}: the return uses the fleet's` : undefined} />
        <Stat label="Receipts" value={String(r.receipts.length)} sub={`${r.receipts.filter((f) => f.counted).length} on the return`} />
      </div>
      <DataTable id="ifta-truck-states" label={`${name} by jurisdiction`} columns={STATES} rows={stateRows} empty={<EmptyState icon="chart" title="No miles or tax-paid fuel this quarter" />} />
      <h3 className="ifta-section">Mileage pieces</h3>
      {r.piecesCapped ? <p className="tl-note warn">More pieces than one page shows: the audit CSV has them all.</p> : null}
      <DataTable id="ifta-truck-pieces" label={`${name} mileage pieces`} columns={PIECES} rows={pieceRows} empty={<EmptyState icon="chart" title="No counted mileage pieces" />} />
      <h3 className="ifta-section">Fuel receipts</h3>
      <DataTable id="ifta-truck-receipts" label={`${name} fuel receipts`} columns={RECEIPTS} rows={receiptRows} empty={<EmptyState icon="chart" title="No fuel bought this quarter" />} />
    </>
  );
}
