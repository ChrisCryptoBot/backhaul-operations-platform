"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { saveLeakIntakeAction } from "@/app/(desk)/actions";
import { INTAKE_LIMITS, formOf, validateIntake, type IntakeForm, type LeakIntake } from "@/lib/leak-intake";
import type { IntakeRoster } from "@/server/tl/leak-intake";
import { useToast } from "../kit/toast";
import { DraftNote, useDraft } from "../kit/use-draft";

/** How many of the most-used trucks and customers on the imported loads start as rows; the rest are one pick away in the name box. */
const SEED_ROWS = 12;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The form as it starts: what is saved, then a blank row for each of the busiest trucks and customers on the imported loads that has no figure yet. */
function startingForm(stored: LeakIntake, roster: IntakeRoster): IntakeForm {
  const f = formOf(stored);
  for (const t of roster.trucks.slice(0, SEED_ROWS)) if (!f.trucks.some((r) => same(r.name, t.name))) f.trucks.push({ name: t.name, costPerMile: "" });
  for (const c of roster.customers.slice(0, SEED_ROWS)) if (!f.customers.some((r) => same(r.name, c.name))) f.customers.push({ name: c.name, detentionRate: "", freeMinutes: "" });
  return f;
}

/**
 * The Leak Read intake: the few numbers an imported file cannot carry. A cost a mile for the fleet (and a truck's own where it differs) prices the empty miles and the shortfall under the floor;
 * detention terms for the fleet (and a customer's own) price the waits at stops. A blank row is dropped. Every line the ledger prices from these says "intake, not frozen at booking".
 */
export function LeakIntakeForm({ stored, roster }: { stored: LeakIntake; roster: IntakeRoster }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [values, setValues, draft] = useDraft<IntakeForm>("leak-intake", startingForm(stored, roster));
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({});
  const check = React.useMemo(() => validateIntake(values), [values]);
  const errors: Record<string, string> = { ...serverErrors, ...(check.ok ? {} : check.errors) };
  const savedJson = JSON.stringify(stored);
  const unchanged = check.ok && JSON.stringify(check.intake) === savedJson;
  const L = INTAKE_LIMITS;

  const setTop = (key: "costPerMile" | "detentionRate" | "freeMinutes") => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const setTruck = (i: number, key: "name" | "costPerMile", value: string) => setValues((v) => ({ ...v, trucks: v.trucks.map((r, j) => (j === i ? { ...r, [key]: value } : r)) }));
  const setCustomer = (i: number, key: "name" | "detentionRate" | "freeMinutes", value: string) => setValues((v) => ({ ...v, customers: v.customers.map((r, j) => (j === i ? { ...r, [key]: value } : r)) }));

  return (
    <>
      <DraftNote draft={draft} what="the intake" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!check.ok) return;
          setServerErrors({});
          start(async () => {
            const out = await saveLeakIntakeAction(values);
            if (out.ok) {
              draft.saved();
              toast({ text: out.changed ? "Intake saved. The Leak ledger now prices imported loads from it." : "Nothing changed.", tone: "ok" });
              router.refresh();
            } else setServerErrors(out.errors);
          });
        }}>
        <h3 className="th-group">What a mile costs you</h3>
        <div className="th-grid">
          <div className="th-field">
            <label htmlFor="li-cpm">Fleet cost a mile, before fuel</label>
            <div className="th-input">
              <input id="li-cpm" name="costPerMile" inputMode="decimal" autoComplete="off" placeholder="1.85" value={values.costPerMile} aria-invalid={errors.costPerMile ? true : undefined} aria-describedby="li-cpm-hint" onChange={setTop("costPerMile")} />
              <span style={{ whiteSpace: "nowrap" }}>$ a mile</span>
            </div>
            <span className="th-hint" id="li-cpm-hint">
              The same meaning as a truck&apos;s break-even floor on its Cost profile: insurance, payments, driver, maintenance and the rest, per mile driven, <b>not counting fuel</b>. Empty miles and the shortfall under the floor are priced at this.
            </span>
            {errors.costPerMile ? <span className="th-err" role="alert">{errors.costPerMile}</span> : null}
          </div>
        </div>

        <h3 className="th-group">Detention terms you bill at</h3>
        <div className="th-grid">
          <div className="th-field">
            <label htmlFor="li-rate">Fleet rate</label>
            <div className="th-input">
              <input id="li-rate" name="detentionRate" inputMode="decimal" autoComplete="off" placeholder="60" value={values.detentionRate} aria-invalid={errors.detentionRate ? true : undefined} aria-describedby="li-rate-hint" onChange={setTop("detentionRate")} />
              <span style={{ whiteSpace: "nowrap" }}>$ an hour</span>
            </div>
            <span className="th-hint" id="li-rate-hint">Used for every customer that has no rate of its own below. With no rate, a wait past the free time is counted and left unpriced: nothing is looked up from a market rate.</span>
            {errors.detentionRate ? <span className="th-err" role="alert">{errors.detentionRate}</span> : null}
          </div>
          <div className="th-field">
            <label htmlFor="li-free">Fleet free time at each stop</label>
            <div className="th-input">
              <input id="li-free" name="freeMinutes" inputMode="numeric" autoComplete="off" placeholder="120" value={values.freeMinutes} aria-invalid={errors.freeMinutes ? true : undefined} aria-describedby="li-free-hint" onChange={setTop("freeMinutes")} />
              <span style={{ whiteSpace: "nowrap" }}>minutes</span>
            </div>
            <span className="th-hint" id="li-free-hint">Taken once at each stop. Left blank, the desk&apos;s own free-time setting is used and the line says so.</span>
            {errors.freeMinutes ? <span className="th-err" role="alert">{errors.freeMinutes}</span> : null}
          </div>
        </div>

        <h3 className="th-group">Trucks with their own cost a mile</h3>
        <p className="tl-sub" style={{ marginTop: 0, maxWidth: "72ch" }}>
          Only where a truck differs from the fleet figure. A truck left with no figure is priced at the fleet&apos;s, so the rows below can be left as they are. Matched on the truck&apos;s name as your file gives it.
          {roster.trucks.length === 0 ? " No imported load has a truck on the desk yet, so there is nothing to list; add a name if you know it." : ""}
        </p>
        <datalist id="li-trucks">
          {[...roster.trucks.map((t) => t.name), ...roster.deskTrucks].map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        {values.trucks.length > 0 ? (
          <table className="tl-table" aria-label="Trucks with their own cost a mile">
            <thead>
              <tr>
                <th scope="col">Truck</th>
                <th scope="col" className="num">Cost a mile</th>
                <th scope="col" className="num">Imported loads</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {values.trucks.map((r, i) => (
                <tr key={i}>
                  <td>
                    <label className="db-sr-only" htmlFor={`li-t-${i}`}>{`Truck ${i + 1}`}</label>
                    <input id={`li-t-${i}`} list="li-trucks" autoComplete="off" value={r.name} maxLength={L.name} aria-invalid={errors[`trucks.${i}.name`] ? true : undefined} onChange={(e) => setTruck(i, "name", e.target.value)} style={{ minWidth: 200 }} />
                    {errors[`trucks.${i}.name`] ? <span className="th-err" role="alert"> {errors[`trucks.${i}.name`]}</span> : null}
                  </td>
                  <td className="num">
                    <label className="db-sr-only" htmlFor={`li-tc-${i}`}>{`Cost a mile for truck ${i + 1}`}</label>
                    <input id={`li-tc-${i}`} inputMode="decimal" autoComplete="off" placeholder="fleet" value={r.costPerMile} aria-invalid={errors[`trucks.${i}.costPerMile`] ? true : undefined} onChange={(e) => setTruck(i, "costPerMile", e.target.value)} style={{ width: 90, textAlign: "right" }} />
                    {errors[`trucks.${i}.costPerMile`] ? <span className="th-err" role="alert"> {errors[`trucks.${i}.costPerMile`]}</span> : null}
                  </td>
                  <td className="num dim">{roster.trucks.find((t) => same(t.name, r.name))?.loads ?? ""}</td>
                  <td>
                    <button type="button" className="tl-btn ghost sm" onClick={() => setValues((v) => ({ ...v, trucks: v.trucks.filter((_, j) => j !== i) }))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <div className="th-actions">
          <button type="button" className="tl-btn sm" onClick={() => setValues((v) => ({ ...v, trucks: [...v.trucks, { name: "", costPerMile: "" }] }))}>
            Add a truck
          </button>
        </div>
        {errors.trucks ? <span className="th-err" role="alert">{errors.trucks}</span> : null}

        <h3 className="th-group">Customers with their own detention terms</h3>
        <p className="tl-sub" style={{ marginTop: 0, maxWidth: "72ch" }}>
          Only where a customer&apos;s contract differs from the fleet terms. Either box may be left blank to use the fleet figure for it, and a customer left with neither is priced at the fleet&apos;s. Matched on the customer&apos;s name as your file gives it.
          {roster.customers.length === 0 ? " No imported load names a customer yet." : ""}
        </p>
        <datalist id="li-customers">
          {roster.customers.map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>
        {values.customers.length > 0 ? (
          <table className="tl-table" aria-label="Customers with their own detention terms">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col" className="num">$ an hour</th>
                <th scope="col" className="num">Free minutes</th>
                <th scope="col" className="num">Imported loads</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {values.customers.map((r, i) => (
                <tr key={i}>
                  <td>
                    <label className="db-sr-only" htmlFor={`li-c-${i}`}>{`Customer ${i + 1}`}</label>
                    <input id={`li-c-${i}`} list="li-customers" autoComplete="off" value={r.name} maxLength={L.name} aria-invalid={errors[`customers.${i}.name`] ? true : undefined} onChange={(e) => setCustomer(i, "name", e.target.value)} style={{ minWidth: 200 }} />
                    {errors[`customers.${i}.name`] ? <span className="th-err" role="alert"> {errors[`customers.${i}.name`]}</span> : null}
                  </td>
                  <td className="num">
                    <label className="db-sr-only" htmlFor={`li-cr-${i}`}>{`Detention rate for customer ${i + 1}`}</label>
                    <input id={`li-cr-${i}`} inputMode="decimal" autoComplete="off" placeholder="fleet" value={r.detentionRate} aria-invalid={errors[`customers.${i}.detentionRate`] ? true : undefined} onChange={(e) => setCustomer(i, "detentionRate", e.target.value)} style={{ width: 80, textAlign: "right" }} />
                    {errors[`customers.${i}.detentionRate`] ? <span className="th-err" role="alert"> {errors[`customers.${i}.detentionRate`]}</span> : null}
                  </td>
                  <td className="num">
                    <label className="db-sr-only" htmlFor={`li-cf-${i}`}>{`Free minutes for customer ${i + 1}`}</label>
                    <input id={`li-cf-${i}`} inputMode="numeric" autoComplete="off" placeholder="fleet" value={r.freeMinutes} aria-invalid={errors[`customers.${i}.freeMinutes`] ? true : undefined} onChange={(e) => setCustomer(i, "freeMinutes", e.target.value)} style={{ width: 80, textAlign: "right" }} />
                    {errors[`customers.${i}.freeMinutes`] ? <span className="th-err" role="alert"> {errors[`customers.${i}.freeMinutes`]}</span> : null}
                  </td>
                  <td className="num dim">{roster.customers.find((c) => same(c.name, r.name))?.loads ?? ""}</td>
                  <td>
                    <button type="button" className="tl-btn ghost sm" onClick={() => setValues((v) => ({ ...v, customers: v.customers.filter((_, j) => j !== i) }))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <div className="th-actions">
          <button type="button" className="tl-btn sm" onClick={() => setValues((v) => ({ ...v, customers: [...v.customers, { name: "", detentionRate: "", freeMinutes: "" }] }))}>
            Add a customer
          </button>
        </div>
        {errors.customers ? <span className="th-err" role="alert">{errors.customers}</span> : null}

        <div className="th-actions" style={{ marginTop: "var(--db-5)" }}>
          <button type="submit" className="tl-btn primary" disabled={pending || !check.ok || unchanged} aria-busy={pending || undefined}>
            {pending ? "Saving…" : "Save the intake"}
          </button>
          {unchanged ? <span className="tl-sub">Saved.</span> : null}
          {!check.ok ? <span className="th-err" role="alert">Fix the fields marked above to save.</span> : null}
        </div>
      </form>
    </>
  );
}
