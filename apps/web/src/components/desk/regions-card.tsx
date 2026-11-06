"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { addRegionAction, archiveRegionAction, renameRegionAction } from "@/app/(desk)/actions";
import type { RegionResult } from "@/server/tl/regions";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

export type RegionCardRow = { id: string; name: string; note: string | null; people: number; terminals: Array<{ id: string; name: string; trucks: number; drivers: number }> };
export type UnassignedRow = { id: string; name: string; trucks: number; drivers: number };

/**
 * The regions a fleet has: groups of terminals that a person can be pointed at, and that the header can show one at a time. An admin adds, renames and retires them; which region each terminal belongs to is
 * set on the Terminals tab. A region owns no trucks or drivers (they stay at their terminal), and one cannot be retired while a person is limited to it.
 */
export function RegionsCard({ regions, unassigned, canEdit }: { regions: RegionCardRow[]; unassigned: UnassignedRow[]; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [add, setAdd, draft] = useDraft("regions:add", { name: "", note: "" });
  const [editing, setEditing] = React.useState<{ id: string; name: string } | null>(null);
  const [error, setError] = React.useState("");

  const run = (job: () => Promise<RegionResult>, done: string, after?: () => void) =>
    start(async () => {
      const out = await job();
      if (out.ok) {
        setError("");
        toast({ text: done, tone: "ok" });
        after?.();
        router.refresh();
      } else setError(out.error);
    });

  const sum = (ts: Array<{ trucks: number; drivers: number }>) => ({ trucks: ts.reduce((s, t) => s + t.trucks, 0), drivers: ts.reduce((s, t) => s + t.drivers, 0) });
  const words = (c: { trucks: number; drivers: number }) => `${c.trucks} ${c.trucks === 1 ? "truck" : "trucks"}, ${c.drivers} ${c.drivers === 1 ? "driver" : "drivers"}`;

  return (
    <>
      <p className="tl-note" style={{ marginBottom: 10, maxWidth: "72ch" }}>
        {regions.length === 0 ? "No regions yet." : `${regions.length} ${regions.length === 1 ? "region" : "regions"}.`} A region groups terminals (Texas, the Southeast). Each person can be limited to a region or to terminals, and anyone can look at one region at a
        time from the header. Trucks and drivers stay at their terminal; put a terminal in a region on the Terminals tab.
        {canEdit ? "" : " Ask an admin to change regions."}
      </p>
      {regions.length > 0 ? (
        <table className="tl-table" aria-label="Regions">
          <thead>
            <tr>
              <th scope="col">Region</th>
              <th scope="col">Terminals</th>
              <th scope="col">Based there</th>
              <th scope="col">People limited to it</th>
              {canEdit ? (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <tr key={r.id}>
                <td>
                  {editing?.id === r.id ? <input aria-label={`New name for ${r.name}`} value={editing.name} maxLength={40} onChange={(e) => setEditing({ id: r.id, name: e.target.value })} /> : <b>{r.name}</b>}
                  {r.note ? <span className="tl-sub" style={{ display: "block" }}>{r.note}</span> : null}
                </td>
                <td>{r.terminals.length === 0 ? <span className="dim">none yet</span> : r.terminals.map((t) => t.name).join(", ")}</td>
                <td>{words(sum(r.terminals))}</td>
                <td>{r.people}</td>
                {canEdit ? (
                  <td style={{ whiteSpace: "nowrap" }}>
                    {editing?.id === r.id ? (
                      <>
                        <button type="button" className="tl-btn sm" disabled={pending} onClick={() => run(() => renameRegionAction(r.id, editing.name), "Region renamed.", () => setEditing(null))}>
                          Save
                        </button>{" "}
                        <button type="button" className="tl-btn ghost sm" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={() => setEditing({ id: r.id, name: r.name })}>
                          Rename
                        </button>{" "}
                        <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={() => run(() => archiveRegionAction(r.id), `${r.name} retired. Its terminals are not in a region now.`)}>
                          Retire
                        </button>
                      </>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {unassigned.length > 0 ? (
        <p className="tl-note" style={{ marginTop: 10, maxWidth: "72ch" }}>
          <b>Not in a region:</b> {unassigned.map((t) => t.name).join(", ")} ({words(sum(unassigned))}). They show under &ldquo;Not in a region&rdquo; in the header until they are placed.
        </p>
      ) : null}
      {error ? (
        <p className="tl-note warn" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
      {canEdit ? (
        <form
          className="tm-form"
          style={{ marginTop: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(() => addRegionAction({ name: add.name, note: add.note }), `${add.name || "The region"} added.`, () => draft.discard());
          }}>
          <label className="tm-f">
            <span className="th-label">New region</span>
            <input type="text" value={add.name} maxLength={40} placeholder="Texas" onChange={(e) => setAdd({ ...add, name: e.target.value })} required />
          </label>
          <label className="tm-f">
            <span className="th-label">Note</span>
            <input type="text" value={add.note} placeholder="Optional" onChange={(e) => setAdd({ ...add, note: e.target.value })} />
          </label>
          <button type="submit" className="tl-btn primary" disabled={pending}>
            Add region
          </button>
        </form>
      ) : null}
    </>
  );
}
