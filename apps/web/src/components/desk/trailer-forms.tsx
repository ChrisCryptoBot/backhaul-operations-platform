"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { assignTrailerAction, hookTrailerAction, saveTrailerAction, setTrailerArchivedAction } from "@/app/(desk)/actions";
import { TERMINAL_LIST_ID, TERMINAL_MAX_LENGTH } from "@/lib/terminal";
import { TRAILER_STATUSES } from "@/lib/trailer-clearance";
import { BLANK_TRAILER, OWNERSHIPS, validateTrailer, type TrailerValues } from "@/lib/trailer-forms";
import { TRAILER_TYPES } from "@/truelane/constants/trailerData";
import { DateInput } from "./date-input";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { TruckPicker } from "./truck-picker";

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="tl-field">
      {label}
      {children}
      {hint ? <span className="th-hint">{hint}</span> : null}
      {error ? (
        <span className="th-err" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

/** A trailer's stored values as the form's own, for editing. */
export type TrailerInfo = TrailerValues & { id: string };

/** The Add trailer dialog and the Edit trailer form on a trailer's own page (`inline`). Checks as you type with the same rules as the server. */
export function TrailerForm({ trailer, onDone, inline }: { trailer?: TrailerInfo; onDone?: () => void; inline?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [values, setValues] = React.useState<TrailerValues>(trailer ?? BLANK_TRAILER);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<keyof TrailerValues, string>>>({});
  const [message, setMessage] = React.useState("");
  const [touched, setTouched] = React.useState<Array<keyof TrailerValues>>([]);
  const [tried, setTried] = React.useState(false);
  const check = validateTrailer(values);
  const all = check.ok ? {} : check.errors;
  const errors = { ...serverErrors, ...(tried ? all : (Object.fromEntries(Object.entries(all).filter(([k]) => touched.includes(k as keyof TrailerValues))) as typeof all)) };
  const set = (k: keyof TrailerValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setTouched((t) => (t.includes(k) ? t : [...t, k]));
    setValues((v) => ({ ...v, [k]: e.target.value }));
  };
  const tick = (k: "hasLiftgate" | "hasETrack") => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.checked ? "yes" : "" }));

  return (
    <form
      className="dlg-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!check.ok) return;
        start(async () => {
          const out = await saveTrailerAction(values, trailer?.id ?? null);
          if (out.ok) {
            toast({ text: out.changed ? (trailer ? `${values.number} saved.` : `${values.number} added.`) : "Nothing changed.", tone: "ok" });
            router.refresh();
            if (!trailer) router.push(`/trailers/${out.id}`);
            onDone?.();
          } else {
            setServerErrors(out.errors ?? {});
            setMessage(out.error ?? "");
          }
        });
      }}>
      <div className="dlg-three">
        <Field label="Number" error={errors.number}>
          <input data-autofocus value={values.number} onChange={set("number")} autoComplete="off" />
        </Field>
        <Field label="Type" error={errors.type}>
          <select value={values.type} onChange={set("type")}>
            <option value="">Not set</option>
            {TRAILER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Ownership" error={errors.ownership}>
          <select value={values.ownership} onChange={set("ownership")}>
            {OWNERSHIPS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Plate" error={errors.plate}>
          <input value={values.plate} onChange={set("plate")} autoComplete="off" />
        </Field>
        <Field label="Plate state" error={errors.plateState}>
          <input value={values.plateState} onChange={set("plateState")} maxLength={2} autoComplete="off" />
        </Field>
        <Field label="VIN" error={errors.vin}>
          <input value={values.vin} onChange={set("vin")} maxLength={17} autoComplete="off" />
        </Field>
        <Field label="Length (ft)" error={errors.lengthFt}>
          <input value={values.lengthFt} onChange={set("lengthFt")} inputMode="decimal" />
        </Field>
        <Field label="Width (in)" error={errors.widthIn}>
          <input value={values.widthIn} onChange={set("widthIn")} inputMode="decimal" />
        </Field>
        <Field label="Axles" error={errors.axles}>
          <input value={values.axles} onChange={set("axles")} inputMode="numeric" />
        </Field>
        <Field label="Empty weight (lb)" error={errors.tareLbs}>
          <input value={values.tareLbs} onChange={set("tareLbs")} inputMode="numeric" />
        </Field>
        <Field label="Payload (lb)" error={errors.maxPayloadLbs} hint="A heavier load is refused.">
          <input value={values.maxPayloadLbs} onChange={set("maxPayloadLbs")} inputMode="numeric" />
        </Field>
        <div className="tl-field">
          Carries
          <div className="th-checks">
            <label className="dlg-check">
              <input type="checkbox" checked={values.hasLiftgate === "yes"} onChange={tick("hasLiftgate")} /> Liftgate
            </label>
            <label className="dlg-check">
              <input type="checkbox" checked={values.hasETrack === "yes"} onChange={tick("hasETrack")} /> E-track
            </label>
          </div>
        </div>
        <Field label="Status" error={errors.status} hint="In the shop or out of service keeps it off loads.">
          <select value={values.status} onChange={set("status")}>
            {TRAILER_STATUSES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Terminal" error={errors.terminal}>
          <input value={values.terminal} onChange={set("terminal")} list={TERMINAL_LIST_ID} maxLength={TERMINAL_MAX_LENGTH} autoComplete="off" />
        </Field>
        <Field label="Where it is" error={errors.location} hint="A yard and door, a dock, a shop.">
          <input value={values.location} onChange={set("location")} autoComplete="off" />
        </Field>
        <Field label="Registration good through" error={errors.registrationExpiry} hint="A lapsed one keeps it off loads.">
          <DateInput type="date" value={values.registrationExpiry} onChange={set("registrationExpiry")} />
        </Field>
        <Field label="Inspection good through" error={errors.inspectionExpiry}>
          <DateInput type="date" value={values.inspectionExpiry} onChange={set("inspectionExpiry")} />
        </Field>
      </div>
      <Field label="Notes" error={errors.notes}>
        <textarea value={values.notes} onChange={set("notes")} rows={2} />
      </Field>
      {message ? (
        <p className="tl-note warn" role="alert">
          {message}
        </p>
      ) : null}
      <div className="dlg-actions">
        {inline ? null : (
          <button type="button" className="tl-btn" onClick={onDone}>
            Cancel
          </button>
        )}
        <button type="submit" className="tl-btn primary" disabled={pending} aria-busy={pending || undefined}>
          {pending ? "Saving…" : trailer ? "Save trailer" : "Add trailer"}
        </button>
      </div>
    </form>
  );
}

export function AddTrailer() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="tl-btn primary" onClick={() => setOpen(true)}>
        Add a trailer
      </button>
      <Modal open={open} onClose={() => setOpen(false)} eyebrow="New trailer" title="Add a trailer" wide>
        <TrailerForm onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

/** Archive (undoable) or restore a trailer; one on an open load says so and waits. */
export function TrailerRowActions({ trailer, hideOpen }: { trailer: { id: string; number: string; archived: boolean; open: number }; hideOpen?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const locked = !trailer.archived && trailer.open > 0;
  const toggle = (archived: boolean) =>
    start(async () => {
      const out = await setTrailerArchivedAction(trailer.id, archived);
      if (!out.ok) {
        toast({ text: out.error, tone: "bad" });
        return;
      }
      router.refresh();
      toast({
        text: archived ? `${trailer.number} archived.` : `${trailer.number} restored.`,
        tone: "ok",
        action: {
          label: "Undo",
          run: async () => {
            await setTrailerArchivedAction(trailer.id, !archived);
            router.refresh();
          }
        }
      });
    });
  return (
    <div className="row-actions">
      {locked ? <span className="tl-chip info">On {trailer.open} open {trailer.open === 1 ? "load" : "loads"}</span> : null}
      {hideOpen ? null : (
        <Link href={`/trailers/${trailer.id}`} className="tl-btn ghost sm">
          Open
        </Link>
      )}
      {trailer.archived ? (
        <button type="button" className="tl-btn sm" disabled={pending} onClick={() => toggle(false)}>
          Restore
        </button>
      ) : (
        <button type="button" className="tl-btn ghost sm" disabled={pending || locked} title={locked ? "Take it off its open loads first" : undefined} onClick={() => toggle(true)}>
          Archive
        </button>
      )}
    </div>
  );
}

/** Hook a trailer to a tractor, chosen by typing its name, or unhook it. A tractor pulls one trailer at a time; the desk says so if it already has one. */
export function HookTrailer({ trailerId, tractor }: { trailerId: string; tractor: { id: string; name: string | null } | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [pick, setPick] = React.useState<{ id: string; name: string }>({ id: "", name: "" });
  const [error, setError] = React.useState("");
  const run = (vehicleId: string, done: string) =>
    start(async () => {
      const out = await hookTrailerAction(trailerId, vehicleId);
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setError("");
      toast({ text: done, tone: "ok" });
      router.refresh();
    });
  return (
    <div>
      {tractor ? (
        <div className="tl-form-row">
          <span>
            Hooked to <Link href={`/fleet/${tractor.id}`}>{tractor.name ?? "a tractor"}</Link>
          </span>
          <button type="button" className="tl-btn sm" disabled={pending} onClick={() => run("", "Unhooked.")}>
            Unhook
          </button>
        </div>
      ) : (
        <div className="tl-form-row">
          <label className="tl-field" style={{ minWidth: 220 }}>
            Hook to a tractor
            <TruckPicker id={pick.id} name={pick.name} onPick={(id, name) => setPick({ id, name })} invalid={pick.id === "?"} label="Tractor" />
          </label>
          <button type="button" className="tl-btn sm primary" disabled={pending || pick.id === "" || pick.id === "?"} onClick={() => run(pick.id, "Hooked.")}>
            Hook
          </button>
        </div>
      )}
      {error ? (
        <p className="tl-note warn" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

type Offer = { id: string; number: string; type: string | null; terminal: string | null; onLoad: string | null; blocker: string | null; warnings: string[] };

/** Put a trailer on a load: type a number, plate or VIN and pick one; what would stop it going on this load shows beside each, and the server refuses it either way. */
export function AssignTrailer({ loadId, current }: { loadId: string; current: { id: string; number: string } | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [text, setText] = React.useState("");
  const [options, setOptions] = React.useState<Offer[]>([]);
  const [error, setError] = React.useState("");
  const list = React.useId();
  React.useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/trailers/pick?q=${encodeURIComponent(text.trim())}&load=${encodeURIComponent(loadId)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { trailers: [] }))
        .then((j: { trailers: Offer[] }) => setOptions(j.trailers))
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, loadId]);
  const hit = options.find((o) => o.number.toLowerCase() === text.trim().toLowerCase());
  const run = (trailerId: string, done: (warnings: string[]) => string) =>
    start(async () => {
      const out = await assignTrailerAction(loadId, trailerId);
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setError("");
      setText("");
      toast({ text: done(out.warnings), tone: out.warnings.length > 0 ? "plain" : "ok" });
      router.refresh();
    });
  return (
    <div>
      {current ? (
        <div className="tl-form-row">
          <span>
            Trailer <Link href={`/trailers/${current.id}`}>{current.number}</Link>
          </span>
          <button type="button" className="tl-btn sm" disabled={pending} onClick={() => run("", () => "Trailer taken off.")}>
            Take off
          </button>
        </div>
      ) : null}
      <div className="tl-form-row">
        <label className="tl-field" style={{ minWidth: 220 }}>
          {current ? "Change trailer" : "Put a trailer on it"}
          <input value={text} list={list} placeholder="Number, plate or VIN" autoComplete="off" onChange={(e) => setText(e.target.value)} />
          <datalist id={list}>
            {options.map((o) => (
              <option key={o.id} value={o.number} label={[o.type ? o.type.replace("_", " ") : null, o.terminal, o.blocker ?? o.onLoad].filter(Boolean).join(" · ") || undefined} />
            ))}
          </datalist>
        </label>
        <button type="button" className="tl-btn sm primary" disabled={pending || !hit} onClick={() => hit && run(hit.id, (w) => (w.length > 0 ? `${hit.number} is on. ${w[0]}` : `${hit.number} is on.`))}>
          Put on
        </button>
      </div>
      {hit?.blocker ? <p className="tl-note warn" style={{ marginTop: 8 }}>{hit.blocker}</p> : null}
      {error ? (
        <p className="tl-note warn" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
