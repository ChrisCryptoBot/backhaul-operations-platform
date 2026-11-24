"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { decideReceiptAction } from "@/app/(desk)/actions";
import { DataTable, type Column, type Row } from "./data-table";
import { Card } from "./ui";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";
import { shortDate, usd } from "@/lib/desk-format";
import { RECEIPT_LABEL } from "@/lib/driver-receipts";
import type { ReceiptView } from "@/server/tl/receipts";

const COLUMNS: Column[] = [
  { key: "driver", label: "Driver", sticky: true, width: 190 },
  { key: "what", label: "What" },
  { key: "amount", label: "Amount", align: "num" },
  { key: "photo", label: "Receipt" },
  { key: "act", label: "", align: "num" }
];

/** Receipts drivers sent from their phones: what waits for a decision, then what was decided lately. Approving puts it on the driver's next statement by itself. Nothing drawn when there are none. */
export function ReceiptQueue({ waiting, decided, canDecide }: { waiting: ReceiptView[]; decided: ReceiptView[]; canDecide: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  // The receipt being declined and the reason typed so far are kept like any desk form: leaving the page does not lose a half-written reason.
  const [decline, setDecline, draft] = useDraft<{ id: string | null; why: string }>("receipt-decline", { id: null, why: "" });
  const declining = waiting.some((r) => r.id === decline.id) ? decline.id : null;
  const why = decline.why;

  async function decide(r: ReceiptView, to: "approved" | "declined" | "submitted", reason: string | null = null) {
    if (busy != null) return;
    setBusy(r.id);
    try {
      const out = await decideReceiptAction(r.id, to, reason);
      if (!out.ok) return toast({ text: out.error, tone: "bad" });
      draft.discard();
      toast({ text: to === "approved" ? `Approved. It goes on ${r.driverName}'s next statement.` : to === "declined" ? `Declined. ${r.driverName} is told why.` : "Put back to be decided.", tone: "ok" });
      router.refresh();
    } catch {
      toast({ text: "That did not go through. Check the connection and try again.", tone: "bad" });
    } finally {
      setBusy(null);
    }
  }

  const row = (r: ReceiptView, act: React.ReactNode): Row => ({
    id: r.id,
    search: [r.driverName, RECEIPT_LABEL[r.kind], r.note].filter(Boolean).join(" "),
    cells: {
      driver: (
        <Link href={`/drivers/${r.driverId}`}>
          <b>{r.driverName}</b>
        </Link>
      ),
      what: (
        <>
          {RECEIPT_LABEL[r.kind]}, {shortDate(new Date(`${r.spentOn}T12:00:00Z`))}
          {r.load ? (
            <span className="sub">
              Load <Link href={`/loads/${r.load.id}`}>{r.load.number ?? "open"}</Link>
            </span>
          ) : null}
          {r.note ? <span className="sub">{r.note}</span> : null}
        </>
      ),
      amount: usd(r.amount, 2),
      photo: r.hasPhoto ? (
        <a href={`/receipts/${r.id}`} target="_blank" rel="noopener">
          View photo
        </a>
      ) : (
        <span className="sub">No photo: {r.photoMissing ?? "none was sent"}</span>
      ),
      act
    }
  });

  const waitingRows = waiting.map((r) =>
    row(
      r,
      !canDecide ? null : declining === r.id ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void decide(r, "declined", why);
          }}>
          <input className="rc-why" value={why} onChange={(e) => setDecline((d) => ({ ...d, why: e.target.value }))} placeholder="Why (the driver reads it)" aria-label={`Why ${r.driverName}'s receipt is declined`} maxLength={200} autoFocus />{" "}
          <button type="submit" className="tl-btn sm" disabled={busy != null || why.trim().length < 3}>
            Decline
          </button>{" "}
          <button type="button" className="tl-btn ghost sm" onClick={() => draft.discard()}>
            Cancel
          </button>
        </form>
      ) : (
        <span className="rc-act">
          <button type="button" className="tl-btn sm" disabled={busy != null} onClick={() => void decide(r, "approved")}>
            Approve
          </button>{" "}
          <button
            type="button"
            className="tl-btn ghost sm"
            disabled={busy != null}
            onClick={() => setDecline({ id: r.id, why: "" })}>
            Decline
          </button>
        </span>
      )
    )
  );
  const decidedRows = decided.map((r) =>
    row(
      r,
      <span className="rc-act">
        {r.statement ? (
          <>
            <span className="t-st" data-tone="ok">Paid back</span> <Link href={`/settlements/${r.statement.id}`}>{r.statement.number}</Link>
          </>
        ) : r.state === "approved" ? (
          <span className="t-st" data-tone="ok">Approved, next statement</span>
        ) : (
          <>
            <span className="t-st" data-tone="warn">Declined</span> <span className="sub">{r.reason}</span>
          </>
        )}
        {canDecide && !r.statement ? (
          <>
            {" "}
            <button type="button" className="tl-btn ghost sm" disabled={busy != null} onClick={() => void decide(r, "submitted")}>
              Put back
            </button>
          </>
        ) : null}
      </span>
    )
  );

  if (waiting.length === 0 && decided.length === 0) return null;
  return (
    <Card title={`Receipts from drivers · ${waiting.length} to decide`}>
      {waitingRows.length > 0 ? <DataTable id="receipts-waiting" label="Receipts waiting for a decision" columns={COLUMNS} rows={waitingRows} /> : <p className="tl-note">Nothing is waiting.</p>}
      {decidedRows.length > 0 ? (
        <details>
          <summary className="tl-sub">Decided lately ({decidedRows.length})</summary>
          <DataTable id="receipts-decided" label="Receipts decided lately" columns={COLUMNS} rows={decidedRows} />
        </details>
      ) : null}
    </Card>
  );
}
