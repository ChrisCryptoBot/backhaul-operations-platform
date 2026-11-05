"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { applyScheduleAction, clearScheduleAction, removeTimeOffAction, saveScheduleAction, saveTimeOffAction, setDriverCodeAction, setDriversHomeAction } from "@/app/(desk)/actions";
import { checkShift, minutesText, parseMinutes, shiftText, type Shift } from "@/lib/shifts";
import type { ConflictView, ShiftResult } from "@/server/tl/shifts";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

/**
 * The roster: every driver's weekly shifts, set by a driver manager or an admin (anyone else reads it). Each row opens an editor for the week, time off and the driver's code and home terminal;
 * ticked rows take one schedule or one home terminal together. A change that would put booked freight outside the new shift is held and listed first, and can still be saved anyway.
 */
export type RosterRow = { driverId: string; name: string; code: string | null; terminal: string | null; week: Array<Shift | null> | null; timeOff: Array<{ dateKey: string; kind: "off" | "shift"; start: number | null; end: number | null; note: string | null }> };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** One day of the editor as typed: on or off, and the two times. */
type DayEdit = { on: boolean; start: string; end: string };
type WeekEdit = DayEdit[];
const BLANK_WEEK: WeekEdit = DAYS.map(() => ({ on: false, start: "06:00", end: "18:00" }));
const WEEKDAYS: WeekEdit = DAYS.map((_, i) => ({ on: i >= 1 && i <= 5, start: "06:00", end: "18:00" }));

const toEdit = (week: Array<Shift | null> | null): WeekEdit => (week ? week.map((s) => (s ? { on: true, start: minutesText(s.start), end: minutesText(s.end) } : { on: false, start: "06:00", end: "18:00" })) : BLANK_WEEK);

/** The week as the server wants it, or the first problem in words. */
function toWeek(edit: WeekEdit): { ok: true; week: Array<Shift | null> } | { ok: false; error: string } {
  const week: Array<Shift | null> = [];
  for (let i = 0; i < 7; i++) {
    const d = edit[i]!;
    if (!d.on) {
      week.push(null);
      continue;
    }
    const s = parseMinutes(d.start);
    const e = parseMinutes(d.end);
    if (s == null || e == null) return { ok: false, error: `${LONG[i]}: type the times as 06:00.` };
    const c = checkShift(s, e);
    if (!c.ok) return { ok: false, error: `${LONG[i]}: ${c.error}` };
    week.push({ start: s, end: e });
  }
  return { ok: true, week };
}

const dayCell = (s: Shift | null | undefined) => (s ? shiftText(s) : "Off");

function Conflicts({ items, onAnyway, busy }: { items: ConflictView[]; onAnyway: () => void; busy: boolean }) {
  return (
    <div className="tl-note warn" role="alert" style={{ display: "grid", gap: 6 }}>
      <b>This puts booked freight outside the shift.</b>
      {items.map((c) => (
        <p key={c.driverId} style={{ margin: 0 }}>
          {c.text}{" "}
          {c.loads.map((l) => (
            <Link key={l.loadId} href={`/loads/${l.loadId}`} target="_blank">
              {l.loadNumber ?? "Load"}
            </Link>
          ))}
        </p>
      ))}
      <div>
        <button type="button" className="tl-btn sm" disabled={busy} onClick={onAnyway}>
          Save anyway
        </button>
      </div>
    </div>
  );
}

function WeekFields({ week, setWeek }: { week: WeekEdit; setWeek: (w: WeekEdit) => void }) {
  const set = (i: number, patch: Partial<DayEdit>) => setWeek(week.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  return (
    <table className="dt" aria-label="Weekly shifts" style={{ width: "100%" }}>
      <tbody>
        {DAYS.map((d, i) => (
          <tr key={d}>
            <th scope="row" style={{ width: 90, textAlign: "left" }}>
              {LONG[i]}
            </th>
            <td>
              <label>
                <input type="checkbox" checked={week[i]!.on} onChange={(e) => set(i, { on: e.target.checked })} /> {week[i]!.on ? "Works" : "Off duty"}
              </label>
            </td>
            <td>
              <input aria-label={`${LONG[i]} start`} value={week[i]!.start} disabled={!week[i]!.on} onChange={(e) => set(i, { start: e.target.value })} size={6} inputMode="numeric" placeholder="06:00" />
              {" to "}
              <input aria-label={`${LONG[i]} end`} value={week[i]!.end} disabled={!week[i]!.on} onChange={(e) => set(i, { end: e.target.value })} size={6} inputMode="numeric" placeholder="18:00" />
              {week[i]!.on && (() => {
                const s = parseMinutes(week[i]!.start);
                const e = parseMinutes(week[i]!.end);
                const c = s != null && e != null ? checkShift(s, e) : null;
                return c?.ok ? <small className="tl-sub"> {Math.round((c.minutes / 60) * 2) / 2} h{e! <= s! ? ", into the next morning" : ""}{c.caution ? `. ${c.caution}` : ""}</small> : null;
              })()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Editor({ row, terminals, canEdit, onClose }: { row: RosterRow; terminals: string[]; canEdit: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [form, setForm, draft] = useDraft(`roster:${row.driverId}`, { week: toEdit(row.week), code: row.code ?? "", terminal: row.terminal ?? "", off: { date: "", kind: "off", start: "06:00", end: "18:00", note: "" } });
  const [error, setError] = React.useState("");
  const [conflicts, setConflicts] = React.useState<ConflictView[] | null>(null);
  const [held, setHeld] = React.useState<(() => Promise<ShiftResult>) | null>(null);

  const run = (go: (force: boolean) => Promise<ShiftResult>, done: string) => {
    start(async () => {
      const out = await go(false);
      settle(out, go, done);
    });
  };
  const settle = (out: ShiftResult, go: (force: boolean) => Promise<ShiftResult>, done: string) => {
    if (out.ok) {
      setError("");
      setConflicts(null);
      setHeld(null);
      toast({ text: done, tone: "ok" });
      router.refresh();
      return true;
    }
    if ("conflicts" in out) {
      setConflicts(out.conflicts);
      setHeld(() => async () => go(true));
      return false;
    }
    setError(out.error);
    setConflicts(null);
    return false;
  };

  const saveWeek = () => {
    const w = toWeek(form.week);
    if (!w.ok) return setError(w.error);
    run((force) => saveScheduleAction(row.driverId, w.week, force), "Shifts saved.");
  };
  const saveCode = () =>
    start(async () => {
      const out = await setDriverCodeAction(row.driverId, form.code);
      if (!out.ok) return setError(out.error);
      setError("");
      toast({ text: "Code saved.", tone: "ok" });
      router.refresh();
    });
  const saveHome = () =>
    start(async () => {
      const out = await setDriversHomeAction([row.driverId], form.terminal || null);
      if (!out.ok) return setError(out.error);
      setError("");
      toast({ text: "Home terminal saved.", tone: "ok" });
      router.refresh();
    });
  const addOff = () => {
    const o = form.off;
    if (!o.date) return setError("Pick a date.");
    const s = parseMinutes(o.start);
    const e = parseMinutes(o.end);
    run((force) => saveTimeOffAction(row.driverId, { dateKey: o.date, kind: o.kind, start: o.kind === "shift" ? s : null, end: o.kind === "shift" ? e : null, note: o.note }, force), o.kind === "off" ? "Time off saved." : "Shift for that day saved.");
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <fieldset disabled={!canEdit || pending} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <section style={{ display: "grid", gap: 8 }}>
          <h3>Weekly shifts</h3>
          <p className="tl-sub">On the carrier&apos;s clock. An end at or before the start runs into the next morning (22:00 to 06:00). {row.week ? "" : "No schedule is set, so this driver is never flagged and is not counted as available."}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="tl-btn ghost sm" onClick={() => setForm({ ...form, week: WEEKDAYS })}>
              Mon to Fri, 06:00 to 18:00
            </button>
            <button
              type="button"
              className="tl-btn ghost sm"
              onClick={() => {
                const first = form.week.find((d) => d.on) ?? form.week[1]!;
                setForm({ ...form, week: form.week.map((d) => (d.on ? { ...d, start: first.start, end: first.end } : d)) });
              }}>
              Same hours on every working day
            </button>
          </div>
          <WeekFields week={form.week} setWeek={(w) => setForm({ ...form, week: w })} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="tl-btn sm" onClick={saveWeek} aria-busy={pending || undefined}>
              Save shifts
            </button>
            {row.week ? (
              <button type="button" className="tl-btn ghost sm" onClick={() => run(() => clearScheduleAction(row.driverId), "Schedule cleared.")}>
                Clear schedule
              </button>
            ) : null}
          </div>
        </section>

        <section style={{ display: "grid", gap: 8 }}>
          <h3>Time off and one-day changes</h3>
          {row.timeOff.length === 0 ? <p className="tl-sub">None coming up.</p> : null}
          <ul className="feed">
            {row.timeOff.map((t) => (
              <li key={t.dateKey}>
                <b>{t.dateKey}</b> {t.kind === "off" ? "Off duty" : `Shift ${shiftText({ start: t.start!, end: t.end! })}`}
                {t.note ? <span className="tl-sub"> {"·"} {t.note}</span> : null}{" "}
                <button type="button" className="tl-btn ghost sm" onClick={() => run((force) => removeTimeOffAction(row.driverId, t.dateKey, force), "Back to the weekly shift.")}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {row.week ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
              <label className="tl-field">
                Date
                <input type="date" value={form.off.date} onChange={(e) => setForm({ ...form, off: { ...form.off, date: e.target.value } })} />
              </label>
              <label className="tl-field">
                What
                <select value={form.off.kind} onChange={(e) => setForm({ ...form, off: { ...form.off, kind: e.target.value } })}>
                  <option value="off">Off duty</option>
                  <option value="shift">A different shift</option>
                </select>
              </label>
              {form.off.kind === "shift" ? (
                <>
                  <label className="tl-field">
                    Start
                    <input value={form.off.start} size={6} onChange={(e) => setForm({ ...form, off: { ...form.off, start: e.target.value } })} />
                  </label>
                  <label className="tl-field">
                    End
                    <input value={form.off.end} size={6} onChange={(e) => setForm({ ...form, off: { ...form.off, end: e.target.value } })} />
                  </label>
                </>
              ) : null}
              <label className="tl-field">
                Note
                <input value={form.off.note} maxLength={120} placeholder="Home time, PTO" onChange={(e) => setForm({ ...form, off: { ...form.off, note: e.target.value } })} />
              </label>
              <button type="button" className="tl-btn sm" onClick={addOff}>
                Add
              </button>
            </div>
          ) : (
            <p className="tl-sub">Set the weekly shifts first; time off is a change to them.</p>
          )}
        </section>

        <section style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <label className="tl-field">
            Driver code
            <input value={form.code} maxLength={8} size={10} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </label>
          <button type="button" className="tl-btn sm" onClick={saveCode}>
            Save code
          </button>
          <label className="tl-field">
            Home terminal
            <select value={form.terminal} onChange={(e) => setForm({ ...form, terminal: e.target.value })}>
              <option value="">None</option>
              {terminals.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="tl-btn sm" onClick={saveHome}>
            Save home
          </button>
          <span className="tl-sub">A home base, not a limit: any driver can be given a load from anywhere.</span>
        </section>
      </fieldset>
      {conflicts && held ? <Conflicts items={conflicts} busy={pending} onAnyway={() =>
            start(async () => {
              settle(await held(), () => held(), "Saved.");
            })
          } /> : null}
      {error ? (
        <p className="tl-note warn" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <button
          type="button"
          className="tl-btn ghost sm"
          onClick={() => {
            draft.discard();
            onClose();
          }}>
          Close
        </button>
      </div>
    </div>
  );
}

function BulkBar({ ids, terminals, clear }: { ids: string[]; terminals: string[]; clear: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [form, setForm] = useDraft("roster:bulk", { week: WEEKDAYS, terminal: "" });
  const [error, setError] = React.useState("");
  const [conflicts, setConflicts] = React.useState<ConflictView[] | null>(null);
  const apply = (force: boolean) => {
    const w = toWeek(form.week);
    if (!w.ok) return setError(w.error);
    start(async () => {
      const out = await applyScheduleAction(ids, w.week, force);
      if (out.ok) {
        setError("");
        setConflicts(null);
        toast({ text: `Shifts saved for ${ids.length} ${ids.length === 1 ? "driver" : "drivers"}.`, tone: "ok" });
        clear();
        router.refresh();
      } else if ("conflicts" in out) setConflicts(out.conflicts);
      else setError(out.error);
    });
  };
  const home = () =>
    start(async () => {
      const out = await setDriversHomeAction(ids, form.terminal || null);
      if (!out.ok) return setError(out.error);
      setError("");
      toast({ text: `Home terminal saved for ${ids.length} ${ids.length === 1 ? "driver" : "drivers"}.`, tone: "ok" });
      clear();
      router.refresh();
    });
  return (
    <div className="tl-note" style={{ display: "grid", gap: 8 }}>
      <b>
        {ids.length} {ids.length === 1 ? "driver" : "drivers"} ticked
      </b>
      <WeekFields week={form.week} setWeek={(w) => setForm({ ...form, week: w })} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <button type="button" className="tl-btn sm" disabled={pending} onClick={() => apply(false)}>
          Apply these shifts to the {ids.length} ticked
        </button>
        <label className="tl-field">
          Home terminal
          <select value={form.terminal} onChange={(e) => setForm({ ...form, terminal: e.target.value })}>
            <option value="">None</option>
            {terminals.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="tl-btn sm" disabled={pending} onClick={home}>
          Set home terminal
        </button>
        <button type="button" className="tl-btn ghost sm" onClick={clear}>
          Untick all
        </button>
      </div>
      {conflicts ? <Conflicts items={conflicts} busy={pending} onAnyway={() => apply(true)} /> : null}
      {error ? (
        <p className="tl-note warn" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function RosterTable({ rows, terminals, canEdit }: { rows: RosterRow[]; terminals: string[]; canEdit: boolean }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [ticked, setTicked] = React.useState<string[]>([]);
  const row = rows.find((r) => r.driverId === open) ?? null;
  const toggle = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  return (
    <>
      {canEdit && ticked.length > 0 ? <BulkBar ids={ticked} terminals={terminals} clear={() => setTicked([])} /> : null}
      <div className="pl-wrap">
        <table className="dt" aria-label="Driver shifts">
          <thead>
            <tr>
              {canEdit ? (
                <th scope="col">
                  <input
                    type="checkbox"
                    aria-label="Tick every driver on this page"
                    checked={rows.length > 0 && ticked.length === rows.length}
                    onChange={(e) => setTicked(e.target.checked ? rows.map((r) => r.driverId) : [])}
                  />
                </th>
              ) : null}
              <th scope="col">Code</th>
              <th scope="col">Driver</th>
              <th scope="col">Home</th>
              {DAYS.map((d) => (
                <th scope="col" key={d}>
                  {d}
                </th>
              ))}
              <th scope="col">Time off</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.driverId}>
                {canEdit ? (
                  <td>
                    <input type="checkbox" aria-label={`Tick ${r.name}`} checked={ticked.includes(r.driverId)} onChange={() => toggle(r.driverId)} />
                  </td>
                ) : null}
                <td>{r.code ? <i className="pl-code">{r.code}</i> : <span className="dim">{"—"}</span>}</td>
                <td>{r.name}</td>
                <td>{r.terminal ?? <span className="dim">{"—"}</span>}</td>
                {DAYS.map((d, i) => (
                  <td key={d} className={r.week && !r.week[i] ? "dim" : undefined}>
                    {r.week ? dayCell(r.week[i]) : <span className="dim">not set</span>}
                  </td>
                ))}
                <td>{r.timeOff.length > 0 ? r.timeOff.length : <span className="dim">{"—"}</span>}</td>
                <td>
                  <button type="button" className="tl-btn ghost sm" onClick={() => setOpen(r.driverId)}>
                    {canEdit ? "Edit" : "View"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal open={row != null} onClose={() => setOpen(null)} title={row ? `${row.name}${row.code ? ` (${row.code})` : ""}` : ""} eyebrow="Shifts" wide>
        {row ? <Editor key={row.driverId} row={row} terminals={terminals} canEdit={canEdit} onClose={() => setOpen(null)} /> : null}
      </Modal>
    </>
  );
}
