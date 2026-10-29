"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { saveCostProfileAction, saveDriverAction, saveTruckAction, setDriverActiveAction, setTruckArchivedAction } from "@/app/(desk)/actions";
import { CDL_CLASSES, FUEL_TYPES, PROFILE_FIELDS, TRUCK_TYPES, profileFloors, validateDriver, validateProfile, validateTruck, type DriverValues, type ProfileKey, type TruckValues } from "@/lib/fleet-forms";
import type { CostProfileMathInput } from "@/truelane/lib/domain/calculators";
import { deltaOf } from "@/lib/kpi-view";
import { perMile, usd } from "@/lib/desk-format";
import { DeltaChip } from "./kpi/parts";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";

// ── Small pieces ───────────────────────────────────────────────────────────────────────────────

function Field({ label, error, children, hint }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
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

/**
 * Which validation messages to show now. A blank form says nothing until a field has been changed; pressing the button
 * then shows every message, so a form that will not save always says why.
 */
function useShownErrors<K extends string>() {
  const [touched, setTouched] = React.useState<K[]>([]);
  const [tried, setTried] = React.useState(false);
  return {
    touch: (k: K) => setTouched((t) => (t.includes(k) ? t : [...t, k])),
    tried: () => setTried(true),
    reset: () => {
      setTouched([]);
      setTried(false);
    },
    filter: (all: Partial<Record<K, string>>): Partial<Record<K, string>> =>
      tried ? all : (Object.fromEntries(Object.entries(all).filter(([k]) => touched.includes(k as K))) as Partial<Record<K, string>>)
  };
}

type Truck = { id: string; name: string | null };

// ── Drivers ────────────────────────────────────────────────────────────────────────────────────

export type DriverRow = { id: string; name: string; phone: string | null; email: string | null; cdlClass: string | null; cdlExpiry: string; medicalCardExpiry: string; truckId: string | null; active: boolean; onLoads: number; onLoadNumbers: string[] };

function DriverDialog({ open, onClose, trucks, driver }: { open: boolean; onClose: () => void; trucks: Truck[]; driver?: DriverRow }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const blank: Record<keyof DriverValues, string> = { name: "", phone: "", email: "", cdlClass: "A", cdlExpiry: "", medicalCardExpiry: "", assignedVehicleId: "" };
  const initial = driver ? { name: driver.name, phone: driver.phone ?? "", email: driver.email ?? "", cdlClass: driver.cdlClass ?? "", cdlExpiry: driver.cdlExpiry, medicalCardExpiry: driver.medicalCardExpiry, assignedVehicleId: driver.truckId ?? "" } : blank;
  const [values, setValues] = React.useState<Record<keyof DriverValues, string>>(initial);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<keyof DriverValues, string>>>({});
  const [message, setMessage] = React.useState("");
  const shown = useShownErrors<keyof DriverValues>();
  React.useEffect(() => {
    if (open) {
      setValues(initial);
      setServerErrors({});
      setMessage("");
      shown.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const check = validateDriver(values);
  const errors = { ...serverErrors, ...shown.filter(check.ok ? {} : check.errors) };
  const set = (k: keyof DriverValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    shown.touch(k);
    setValues((v) => ({ ...v, [k]: e.target.value }));
  };

  return (
    <Modal open={open} onClose={onClose} eyebrow={driver ? "Edit driver" : "New driver"} title={driver ? driver.name : "Add a driver"}>
      <form
        className="dlg-form"
        onSubmit={(e) => {
          e.preventDefault();
          shown.tried();
          if (!check.ok) return;
          start(async () => {
            const out = await saveDriverAction(values, driver?.id ?? null);
            if (out.ok) {
              toast({ text: out.changed ? (driver ? `${values.name} saved.` : `${values.name} added.`) : "Nothing changed.", tone: "ok" });
              router.refresh();
              onClose();
            } else {
              setServerErrors(out.errors ?? {});
              setMessage(out.error ?? "");
            }
          });
        }}>
        <Field label="Name" error={errors.name}>
          <input data-autofocus value={values.name} onChange={set("name")} autoComplete="off" />
        </Field>
        <div className="dlg-two">
          <Field label="Phone" error={errors.phone}>
            <input value={values.phone} onChange={set("phone")} inputMode="tel" autoComplete="off" />
          </Field>
          <Field label="Email" error={errors.email}>
            <input value={values.email} onChange={set("email")} inputMode="email" autoComplete="off" />
          </Field>
        </div>
        <div className="dlg-two">
          <Field label="CDL class" error={errors.cdlClass}>
            <select value={values.cdlClass} onChange={set("cdlClass")}>
              <option value="">None</option>
              {CDL_CLASSES.map((c) => (
                <option key={c} value={c}>
                  Class {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Drives" error={errors.assignedVehicleId}>
            <select value={values.assignedVehicleId} onChange={set("assignedVehicleId")}>
              <option value="">No set truck</option>
              {trucks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="dlg-two">
          <Field label="CDL good through" error={errors.cdlExpiry} hint="A card that has lapsed blocks assignments.">
            <input type="date" value={values.cdlExpiry} onChange={set("cdlExpiry")} />
          </Field>
          <Field label="Medical card good through" error={errors.medicalCardExpiry}>
            <input type="date" value={values.medicalCardExpiry} onChange={set("medicalCardExpiry")} />
          </Field>
        </div>
        {message ? (
          <p className="tl-note warn" role="alert">
            {message}
          </p>
        ) : null}
        <div className="dlg-actions">
          <button type="button" className="tl-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="tl-btn primary" disabled={pending} aria-busy={pending || undefined}>
            {pending ? "Saving…" : driver ? "Save driver" : "Add driver"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AddDriver({ trucks }: { trucks: Truck[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="tl-btn primary" onClick={() => setOpen(true)}>
        Add a driver
      </button>
      <DriverDialog open={open} onClose={() => setOpen(false)} trucks={trucks} />
    </>
  );
}

/** Edit, and take out of service or bring back. A driver on an open load shows that and cannot be taken out until they are off it. */
export function DriverRowActions({ driver, trucks }: { driver: DriverRow; trucks: Truck[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [pending, start] = React.useTransition();
  const locked = driver.active && driver.onLoads > 0;
  const toggle = (active: boolean) =>
    start(async () => {
      const out = await setDriverActiveAction(driver.id, active);
      if (!out.ok) {
        toast({ text: out.error, tone: "bad" });
        return;
      }
      router.refresh();
      toast({
        text: active ? `${driver.name} is back in service.` : `${driver.name} taken out of service.`,
        tone: "ok",
        action: {
          label: "Undo",
          run: async () => {
            await setDriverActiveAction(driver.id, !active);
            router.refresh();
          }
        }
      });
    });
  return (
    <div className="row-actions">
      {locked ? (
        <span className="tl-chip info" title={`On ${driver.onLoadNumbers.join(", ")}`}>
          On {driver.onLoads} {driver.onLoads === 1 ? "load" : "loads"}
        </span>
      ) : null}
      <button type="button" className="tl-btn ghost sm" onClick={() => setOpen(true)}>
        Edit
      </button>
      {driver.active ? (
        <button type="button" className="tl-btn ghost sm" disabled={pending || locked} title={locked ? "Take them off their open loads first" : undefined} onClick={() => toggle(false)}>
          Deactivate
        </button>
      ) : (
        <button type="button" className="tl-btn sm" disabled={pending} onClick={() => toggle(true)}>
          Reactivate
        </button>
      )}
      <DriverDialog open={open} onClose={() => setOpen(false)} trucks={trucks} driver={driver} />
    </div>
  );
}

// ── Trucks ─────────────────────────────────────────────────────────────────────────────────────

function TruckFields({ values, set, errors }: { values: Record<keyof TruckValues, string>; set: (k: keyof TruckValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void; errors: Partial<Record<keyof TruckValues, string>> }) {
  return (
    <>
      <Field label="Name" error={errors.name}>
        <input data-autofocus value={values.name} onChange={set("name")} placeholder="Unit 104" autoComplete="off" />
      </Field>
      <div className="dlg-two">
        <Field label="Type" error={errors.type}>
          <select value={values.type} onChange={set("type")}>
            <option value="">Not set</option>
            {TRUCK_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fuel" error={errors.fuelType}>
          <select value={values.fuelType} onChange={set("fuelType")}>
            <option value="">Not set</option>
            {FUEL_TYPES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="dlg-two">
        <Field label="Miles per gallon" error={errors.mpg} hint="Verdicts use this for fuel.">
          <input value={values.mpg} onChange={set("mpg")} inputMode="decimal" autoComplete="off" />
        </Field>
        <Field label="Home base" error={errors.homeBaseAddress}>
          <input value={values.homeBaseAddress} onChange={set("homeBaseAddress")} placeholder="Dallas, TX" autoComplete="off" />
        </Field>
      </div>
    </>
  );
}

export type TruckInfo = { id: string; name: string | null; type: string | null; mpg: number | null; fuelType: string | null; homeBase: string | null };

const truckValues = (t?: TruckInfo): Record<keyof TruckValues, string> => ({ name: t?.name ?? "", type: t?.type ?? "", mpg: t?.mpg == null ? "" : String(t.mpg), fuelType: t?.fuelType ?? "", homeBaseAddress: t?.homeBase ?? "" });

/** Add a truck (a dialog), or edit one's details (inline on its own page). */
export function TruckForm({ truck, onDone, inline }: { truck?: TruckInfo; onDone?: () => void; inline?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [values, setValues] = React.useState(truckValues(truck));
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<keyof TruckValues, string>>>({});
  const [message, setMessage] = React.useState("");
  const shown = useShownErrors<keyof TruckValues>();
  const check = validateTruck(values);
  const errors = { ...serverErrors, ...shown.filter(check.ok ? {} : check.errors) };
  const set = (k: keyof TruckValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    shown.touch(k);
    setValues((v) => ({ ...v, [k]: e.target.value }));
  };
  const unchanged = truck != null && JSON.stringify(values) === JSON.stringify(truckValues(truck));
  return (
    <form
      className="dlg-form"
      onSubmit={(e) => {
        e.preventDefault();
        shown.tried();
        if (!check.ok) return;
        start(async () => {
          const out = await saveTruckAction(values, truck?.id ?? null);
          if (out.ok) {
            toast({ text: out.changed ? (truck ? `${values.name} saved.` : `${values.name} added.`) : "Nothing changed.", tone: "ok" });
            router.refresh();
            if (!truck) router.push(`/fleet/${out.id}`);
            onDone?.();
          } else {
            setServerErrors(out.errors ?? {});
            setMessage(out.error ?? "");
          }
        });
      }}>
      <TruckFields values={values} set={set} errors={errors} />
      {message ? (
        <p className="tl-note warn" role="alert">
          {message}
        </p>
      ) : null}
      <div className={inline ? "th-actions" : "dlg-actions"}>
        {!inline ? (
          <button type="button" className="tl-btn" onClick={onDone}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="tl-btn primary" disabled={pending || unchanged} aria-busy={pending || undefined}>
          {pending ? "Saving…" : truck ? "Save truck" : "Add truck"}
        </button>
      </div>
    </form>
  );
}

export function AddTruck() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="tl-btn primary" onClick={() => setOpen(true)}>
        Add a truck
      </button>
      <Modal open={open} onClose={() => setOpen(false)} eyebrow="New truck" title="Add a truck">
        <p className="tl-note" style={{ marginBottom: 10 }}>You set its costs next, on its own page. Until it has a cost profile, loads on it show no verdict.</p>
        <TruckForm onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

/** Open the truck, and archive or restore it. A truck with an open load shows that and cannot be archived until the load is done. */
export function TruckRowActions({ truck, hideOpen }: { truck: { id: string; name: string | null; archived: boolean; open: number }; hideOpen?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const locked = !truck.archived && truck.open > 0;
  const toggle = (archived: boolean) =>
    start(async () => {
      const out = await setTruckArchivedAction(truck.id, archived);
      if (!out.ok) {
        toast({ text: out.error, tone: "bad" });
        return;
      }
      router.refresh();
      toast({
        text: archived ? `${truck.name} archived.` : `${truck.name} restored.`,
        tone: "ok",
        action: {
          label: "Undo",
          run: async () => {
            await setTruckArchivedAction(truck.id, !archived);
            router.refresh();
          }
        }
      });
    });
  return (
    <div className="row-actions">
      {locked ? (
        <span className="tl-chip info">
          On {truck.open} open {truck.open === 1 ? "load" : "loads"}
        </span>
      ) : null}
      {hideOpen ? null : (
        <Link href={`/fleet/${truck.id}`} className="tl-btn ghost sm">
          Open
        </Link>
      )}
      {truck.archived ? (
        <button type="button" className="tl-btn sm" disabled={pending} onClick={() => toggle(false)}>
          Restore
        </button>
      ) : (
        <button type="button" className="tl-btn ghost sm" disabled={pending || locked} title={locked ? "Finish or move its open loads first" : undefined} onClick={() => toggle(true)}>
          Archive
        </button>
      )}
    </div>
  );
}

// ── Cost profile ───────────────────────────────────────────────────────────────────────────────

const GROUP_TITLE = { fixed: "Fixed costs", miles: "Miles and upkeep", driving: "Fuel and the driver", dock: "Detention" } as const;

/**
 * A truck's costs, with the floor it produces redrawn as you type. The floor is TrueLane's own function, the same one the server
 * runs on save; "was" is the floor stored today. Open loads on the truck are judged on the new floor, finished loads keep theirs.
 */
export function CostProfileForm({
  vehicleId,
  numbers,
  base,
  insuranceItemised,
  stored,
  openLoads
}: {
  vehicleId: string;
  numbers: Record<ProfileKey, number | null>;
  base: Partial<CostProfileMathInput>;
  insuranceItemised: boolean;
  stored: { breakEven: number; survival: number | null } | null;
  openLoads: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const text = (n: number | null) => (n == null ? "" : String(n));
  const start0 = React.useMemo(() => Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, text(numbers[f.key])])) as Record<ProfileKey, string>, [numbers]);
  const [values, setValues] = React.useState(start0);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<ProfileKey, string>>>({});
  const check = validateProfile(values);
  const errors = { ...serverErrors, ...(check.ok ? {} : check.errors) };
  const floors = check.ok ? profileFloors(check.numbers, base) : null;
  const unchanged = JSON.stringify(values) === JSON.stringify(start0);

  return (
    <form
      className="cp"
      onSubmit={(e) => {
        e.preventDefault();
        if (!check.ok) return;
        setServerErrors({});
        start(async () => {
          const out = await saveCostProfileAction(vehicleId, values);
          if (out.ok) {
            toast({ text: out.changed ? `Cost profile saved. The floor is ${perMile(out.floors?.breakEven)}.` : "Nothing changed.", tone: "ok" });
            router.refresh();
          } else setServerErrors(out.errors ?? {});
        });
      }}>
      <div className="cp-fields">
        {(Object.keys(GROUP_TITLE) as Array<keyof typeof GROUP_TITLE>).map((g) => (
          <React.Fragment key={g}>
            <h3 className="th-group">{GROUP_TITLE[g]}</h3>
            <div className="th-grid">
              {PROFILE_FIELDS.filter((f) => f.group === g).map((f) => {
                const locked = f.key === "monthlyInsurance" && insuranceItemised;
                const id = `cp-${f.key}`;
                return (
                  <div className="th-field" key={f.key}>
                    <label htmlFor={id}>{f.label}</label>
                    <div className="th-input">
                      <input id={id} inputMode="decimal" autoComplete="off" value={values[f.key]} disabled={locked} aria-invalid={errors[f.key] ? true : undefined} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                      <span>{f.unit}</span>
                    </div>
                    {locked ? <span className="th-hint">Insurance is itemised on this profile; the itemised amounts are used.</span> : f.hint ? <span className="th-hint">{f.hint}</span> : null}
                    {errors[f.key] ? (
                      <span className="th-err" role="alert">
                        {errors[f.key]}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </React.Fragment>
        ))}
        <div className="th-actions">
          <button type="submit" className="tl-btn primary" disabled={pending || !check.ok || unchanged} aria-busy={pending || undefined}>
            {pending ? "Saving…" : stored ? "Save cost profile" : "Create cost profile"}
          </button>
          {unchanged && stored ? <span className="tl-sub">Saved.</span> : null}
        </div>
      </div>

      <aside className="cp-preview" aria-live="polite" aria-label="The floor these costs give">
        <div className="km-label">Break-even floor</div>
        <div className="km-value">{floors ? perMile(floors.breakEvenRpm) : "—"}</div>
        <div className="cp-was">
          {stored ? <>was {perMile(stored.breakEven)} </> : <>no profile yet </>}
          {floors && stored ? <DeltaChip delta={deltaOf(floors.breakEvenRpm, stored.breakEven, { kind: "pct", lowerIsBetter: true })} /> : null}
        </div>
        <div className="km-label" style={{ marginTop: 16 }}>Survival floor</div>
        <div className="cp-sub">{floors ? perMile(floors.survivalFloorRpm) : "—"} <span>fixed costs only, nothing for upkeep</span></div>
        {floors ? (
          <dl className="tl-kv" style={{ marginTop: 16 }}>
            <dt>Fixed costs a month</dt>
            <dd>{usd(floors.totalFixedMonthly)}</dd>
            <dt>Per mile, fixed</dt>
            <dd>{perMile(floors.totalFixedCpm)}</dd>
            <dt>of which insurance</dt>
            <dd>{perMile(floors.insuranceCpm)}</dd>
            <dt>Maintenance and tires</dt>
            <dd>{perMile(floors.maintenanceCpm + floors.tireCpm)}</dd>
          </dl>
        ) : (
          <p className="tl-note" style={{ marginTop: 12 }}>Fix the fields marked above to see the floor.</p>
        )}
        <p className="tl-note" style={{ marginTop: 14 }}>
          {openLoads > 0 ? `${openLoads} open ${openLoads === 1 ? "load is" : "loads are"} on this truck and will be judged on the new floor. ` : ""}
          Finished loads keep the floor they were accepted at. Each verdict adds fuel for the load&apos;s own miles on top.
        </p>
      </aside>
    </form>
  );
}
