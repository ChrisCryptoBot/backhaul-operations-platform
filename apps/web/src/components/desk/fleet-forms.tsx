"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { saveCostProfileAction, saveDriverAction, saveTruckAction, setDriverActiveAction, setTruckArchivedAction } from "@/app/(desk)/actions";
import { CDL_CLASSES, DEFAULT_BURDEN_PERCENT, DEFAULT_CARRIER_CUT_PERCENT, FUEL_TYPES, PAY_KINDS, PROFILE_FIELDS, TRUCK_TYPES, canonicalTruckType, industryValues, previewOf, profileField, profileSummary, profileWarnings, readChoices, truckMpg, typicalBands, validateDriver, validateProfile, validateTruck, type DriverValues, type ProfileChoices, type ProfileErrorKey, type ProfileKey, type ProfileNumbers, type ProfileValues, type TruckValues } from "@/lib/fleet-forms";
import { pickMake, pickModel, specFill, truckMakes, truckModels, truckYears, withCurrent } from "@/lib/truck-specs";
import { RATE_CON_BASIS } from "@/lib/pay";
import { AddressInput } from "./address-input";
import { COST_ARCHETYPES } from "@/truelane/lib/domain/costArchetype";
import type { CostProfileMathInput } from "@/truelane/lib/domain/calculators";
import { deltaOf } from "@/lib/kpi-view";
import { perMile, usd } from "@/lib/desk-format";
import { DeltaChip } from "./kpi/parts";
import { ConfirmDialog, Modal } from "./kit/modal";
import { fuelKindOf } from "@/lib/eia";
import { useToast } from "./kit/toast";
import { LiveFuelPrice } from "./live-fuel-price";
import { DateInput } from "./date-input";

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
    /** Something has been changed or the button pressed. */
    active: tried || touched.length > 0,
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

export type DriverRow = { id: string; name: string; phone: string | null; email: string | null; cdlClass: string | null; cdlExpiry: string; medicalCardExpiry: string; truckId: string | null; payKind: string; payRate: string; active: boolean; onLoads: number; onLoadNumbers: string[] };

function DriverDialog({ open, onClose, trucks, driver }: { open: boolean; onClose: () => void; trucks: Truck[]; driver?: DriverRow }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const blank: Record<keyof DriverValues, string> = { name: "", phone: "", email: "", cdlClass: "A", cdlExpiry: "", medicalCardExpiry: "", assignedVehicleId: "", payKind: "", payRate: "" };
  const initial = driver ? { name: driver.name, phone: driver.phone ?? "", email: driver.email ?? "", cdlClass: driver.cdlClass ?? "", cdlExpiry: driver.cdlExpiry, medicalCardExpiry: driver.medicalCardExpiry, assignedVehicleId: driver.truckId ?? "", payKind: driver.payKind, payRate: driver.payRate } : blank;
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
          <Field label="Usual pay" error={errors.payKind} hint="New loads start from it. The pay on a load can still be changed.">
            <select value={values.payKind} onChange={set("payKind")}>
              <option value="">Not set</option>
              {PAY_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Rate${values.payKind ? ` (${PAY_KINDS.find((k) => k.key === values.payKind)?.unit})` : ""}`} error={errors.payRate} hint={values.payKind === "percent" ? `A share of ${RATE_CON_BASIS}.` : undefined}>
            <input value={values.payRate} onChange={set("payRate")} inputMode="decimal" autoComplete="off" disabled={!values.payKind} />
          </Field>
        </div>
        <div className="dlg-two">
          <Field label="CDL good through" error={errors.cdlExpiry} hint="A card that has lapsed blocks assignments.">
            <DateInput type="date" value={values.cdlExpiry} onChange={set("cdlExpiry")} />
          </Field>
          <Field label="Medical card good through" error={errors.medicalCardExpiry}>
            <DateInput type="date" value={values.medicalCardExpiry} onChange={set("medicalCardExpiry")} />
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

type TruckErrors = Partial<Record<keyof TruckValues, string>>;

function TruckFields({ values, set, errors, onMake, onModel }: { values: Record<keyof TruckValues, string>; set: (k: keyof TruckValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void; errors: TruckErrors; onMake: (make: string) => void; onModel: (model: string) => void }) {
  // A truck that is not in the phone's list is typed in. A stored make or model that is not in the list opens as typing, so editing it shows what is there.
  const [typeMake, setTypeMake] = React.useState(values.make !== "" && !truckMakes().includes(values.make));
  const [typeModel, setTypeModel] = React.useState(values.model !== "" && !truckModels(values.make).includes(values.model));
  const makeBox = React.useRef<HTMLInputElement>(null);
  const modelBox = React.useRef<HTMLInputElement>(null);
  // A make that is not listed has no models to choose from, so its model is typed too.
  const modelTyped = typeMake || typeModel;
  const makes = truckMakes();
  const models = truckModels(values.make);
  // A year is picked only when the dataset has years for this model; otherwise it is typed (a one-item list made of what was typed would swallow the keyboard).
  const listedYears = truckYears(values.make, values.model);
  const years = withCurrent(listedYears, values.year === "" || Number.isNaN(Number(values.year)) ? "" : Number(values.year));
  const known = specFill(values.make, values.model);
  const modelHint = known ? "Type, miles per gallon, payload and cargo size fill in from this model. Change any that are not right for this truck." : values.model ? "No specs on file for this one. Enter them below." : undefined;
  const makeHint = typeMake ? "Not in the list? Type the make and model, then enter the specs below." : undefined;
  const typeIn = (which: "make" | "model") => {
    if (which === "make") {
      onMake("");
      setTypeMake(true);
      setTimeout(() => makeBox.current?.focus(), 0);
    } else {
      onModel("");
      setTypeModel(true);
      setTimeout(() => modelBox.current?.focus(), 0);
    }
  };
  const backToList = (which: "make" | "model") => {
    if (which === "make") {
      onMake("");
      setTypeMake(false);
      setTypeModel(false);
    } else {
      onModel("");
      setTypeModel(false);
    }
  };
  const NOT_LISTED = "__not_listed__";
  return (
    <>
      <Field label="Name" error={errors.name}>
        <input data-autofocus value={values.name} onChange={set("name")} placeholder="Unit 104" autoComplete="off" />
      </Field>
      <div className="dlg-two">
        <Field label="Make" error={errors.make} hint={makeHint}>
          {typeMake ? (
            <>
              <input ref={makeBox} value={values.make} onChange={set("make")} placeholder="Make" autoComplete="off" />
              <button type="button" className="tl-btn sm" style={{ marginTop: 6 }} onClick={() => backToList("make")}>
                Pick from the list instead
              </button>
            </>
          ) : (
            <select value={values.make} onChange={(e) => (e.target.value === NOT_LISTED ? typeIn("make") : onMake(e.target.value))}>
              <option value="">Not set</option>
              {makes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value={NOT_LISTED}>Not listed, type it in</option>
            </select>
          )}
        </Field>
        <Field label="Model" error={errors.model} hint={modelHint}>
          {modelTyped ? (
            <>
              <input ref={modelBox} value={values.model} onChange={set("model")} placeholder="Model" autoComplete="off" />
              {!typeMake ? (
                <button type="button" className="tl-btn sm" style={{ marginTop: 6 }} onClick={() => backToList("model")}>
                  Pick from the list instead
                </button>
              ) : null}
            </>
          ) : (
            <select value={values.model} onChange={(e) => (e.target.value === NOT_LISTED ? typeIn("model") : onModel(e.target.value))} disabled={values.make === ""}>
              <option value="">{values.make === "" ? "Pick a make first" : "Not set"}</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              <option value={NOT_LISTED}>Not listed, type it in</option>
            </select>
          )}
        </Field>
      </div>
      <div className="dlg-two">
        <Field label="Year" error={errors.year}>
          {listedYears.length > 0 ? (
            <select value={values.year} onChange={set("year")}>
              <option value="">Not set</option>
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          ) : (
            <input value={values.year} onChange={set("year")} inputMode="numeric" placeholder="2022" autoComplete="off" />
          )}
        </Field>
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
      </div>
      <div className="dlg-two">
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
        <Field label="Miles per gallon" error={errors.mpg} hint="Verdicts use this for fuel.">
          <input value={values.mpg} onChange={set("mpg")} inputMode="decimal" autoComplete="off" />
        </Field>
      </div>
      <div className="dlg-two">
        <Field label="Payload (lb)" error={errors.payloadLbs}>
          <input value={values.payloadLbs} onChange={set("payloadLbs")} inputMode="numeric" autoComplete="off" />
        </Field>
        <Field label="Cargo length (ft)" error={errors.maxLengthFt}>
          <input value={values.maxLengthFt} onChange={set("maxLengthFt")} inputMode="decimal" autoComplete="off" />
        </Field>
      </div>
      <div className="dlg-two">
        <Field label="Cargo width (ft)" error={errors.maxWidthFt}>
          <input value={values.maxWidthFt} onChange={set("maxWidthFt")} inputMode="decimal" autoComplete="off" />
        </Field>
        <Field label="Cargo height (in)" error={errors.maxHeightIn}>
          <input value={values.maxHeightIn} onChange={set("maxHeightIn")} inputMode="decimal" autoComplete="off" />
        </Field>
      </div>
      <Field label="Carries" hint="Loads that need one are checked against this.">
        <div className="th-checks">
          {(
            [
              ["hasLiftgate", "Liftgate"],
              ["hasRamp", "Ramp"],
              ["hasPalletJack", "Pallet jack"]
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="dlg-check">
              <input type="checkbox" checked={values[k] === "yes"} onChange={(e) => set(k)({ target: { value: e.target.checked ? "yes" : "" } } as React.ChangeEvent<HTMLInputElement>)} />
              {label}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Home base" error={errors.homeBaseAddress}>
        <AddressInput label="Home base" value={values.homeBaseAddress} placeholder="Dallas, TX" onChange={(text) => set("homeBaseAddress")({ target: { value: text } } as React.ChangeEvent<HTMLInputElement>)} />
      </Field>
    </>
  );
}

export type TruckInfo = {
  id: string;
  name: string | null;
  type: string | null;
  mpg: number | null;
  fuelType: string | null;
  homeBase: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  payloadLbs?: number | null;
  maxLengthFt?: number | null;
  maxWidthFt?: number | null;
  maxHeightIn?: number | null;
  hasLiftgate?: boolean;
  hasRamp?: boolean;
  hasPalletJack?: boolean;
};

const text = (n: number | null | undefined) => (n == null ? "" : String(n));
const truckValues = (t?: TruckInfo): Record<keyof TruckValues, string> => ({
  name: t?.name ?? "",
  type: t?.type ?? "",
  mpg: text(t?.mpg),
  fuelType: t?.fuelType ?? "",
  homeBaseAddress: t?.homeBase ?? "",
  make: t?.make ?? "",
  model: t?.model ?? "",
  year: text(t?.year),
  payloadLbs: text(t?.payloadLbs),
  maxLengthFt: text(t?.maxLengthFt),
  maxWidthFt: text(t?.maxWidthFt),
  maxHeightIn: text(t?.maxHeightIn),
  hasLiftgate: t?.hasLiftgate ? "yes" : "",
  hasRamp: t?.hasRamp ? "yes" : "",
  hasPalletJack: t?.hasPalletJack ? "yes" : ""
});

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
  const onMake = (make: string) => {
    shown.touch("make");
    setValues((v) => pickMake(v, make));
  };
  const onModel = (model: string) => {
    shown.touch("model");
    setValues((v) => pickModel(v, model));
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
      <TruckFields values={values} set={set} errors={errors} onMake={onMake} onModel={onModel} />
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

/**
 * A truck's costs, in the phone's four steps (fixed bills, miles and upkeep, who drives, targets) on one page, with the numbers they
 * give redrawn as you type. The floor is TrueLane's own function, the same one the server runs on save; "was" is the floor stored
 * today. Open loads on the truck are judged on the new floor, finished loads keep theirs. Before saving, anything the phone would
 * ask "did you mean" about (a percent of 50 or more, a fuel price or reserve outside its usual range) is confirmed.
 */
export function CostProfileForm({
  vehicleId,
  vehicleType,
  mpg,
  numbers,
  choices,
  base,
  stored,
  openLoads,
  fuelType,
  homeBase
}: {
  vehicleId: string;
  vehicleType: string | null;
  mpg: number | null;
  numbers: ProfileNumbers;
  choices: ProfileChoices;
  base: Partial<CostProfileMathInput>;
  stored: { breakEven: number; survival: number | null } | null;
  openLoads: number;
  /** The truck's fuel and where it is based, so today's price is the right one for it. */
  fuelType?: string | null;
  homeBase?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const isNew = stored == null;
  const text = (n: number | null) => (n == null ? "" : String(n));
  const start0 = React.useMemo(() => {
    const v = Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, text(numbers[f.key])])) as Record<string, string>;
    // A truck with no profile yet starts from the industry numbers for its type, as the phone's wizard does.
    if (isNew) Object.assign(v, industryValues(vehicleType));
    return { ...v, archetype: choices.archetype, payKind: choices.payKind, fscCut: choices.fscCut ?? "", insuranceItemised: choices.insuranceItemised ? "1" : "", routeMinimumOn: choices.routeMinimumOn ? "1" : "" } as ProfileValues;
  }, [numbers, choices, isNew, vehicleType]);
  const [values, setValues] = React.useState<ProfileValues>(start0);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<ProfileErrorKey, string>>>({});
  const [warnings, setWarnings] = React.useState<string[] | null>(null);
  const shown = useShownErrors<ProfileErrorKey>();

  const check = validateProfile(values);
  const errors = { ...serverErrors, ...shown.filter(check.ok ? {} : check.errors) };
  const preview = previewOf(values, base);
  const live = readChoices(values).choices;
  const unchanged = JSON.stringify(values) === JSON.stringify(start0);
  const typical = typicalBands(vehicleType);
  const truckMpgInfo = truckMpg(vehicleType, mpg);
  const summary = preview ? profileSummary(preview.floors, preview.numbers, truckMpgInfo.mpg, truckMpgInfo.typical) : null;
  const typeLabel = TRUCK_TYPES.find((t) => t.key === canonicalTruckType(vehicleType))?.label.toLowerCase();

  const set = (k: keyof ProfileValues, v: string) => {
    shown.touch(k as ProfileErrorKey);
    setValues((s) => ({
      ...s,
      [k]: v,
      // Choosing who drives starts the number that goes with it where the phone starts it, so a blank is never read as 0%.
      ...(k === "archetype" && v === "hired_driver" && s.laborBurdenPct === "" ? { laborBurdenPct: String(DEFAULT_BURDEN_PERCENT) } : {}),
      ...(k === "archetype" && v === "leased_on" && s.carrierCutPct === "" ? { carrierCutPct: String(DEFAULT_CARRIER_CUT_PERCENT) } : {})
    }));
  };

  function save() {
    setServerErrors({});
    setWarnings(null);
    start(async () => {
      const out = await saveCostProfileAction(vehicleId, values);
      if (out.ok) {
        toast({ text: out.changed ? `Cost profile saved. The floor is ${perMile(out.floors?.breakEven)}.` : "Nothing changed.", tone: "ok" });
        router.refresh();
      } else {
        shown.tried();
        setServerErrors(out.errors ?? {});
        if (out.error) toast({ text: out.error, tone: "bad" });
      }
    });
  }

  function field(key: ProfileKey, opts: { label?: string; hint?: string } = {}) {
    const f = profileField(key);
    const id = `cp-${key}`;
    const hint = opts.hint ?? typical[key] ?? f.hint;
    const err = errors[key];
    return (
      <div className="th-field" key={key}>
        <label htmlFor={id}>{opts.label ?? f.label}</label>
        <div className="th-input">
          <input id={id} inputMode="decimal" autoComplete="off" value={values[key]} aria-invalid={err ? true : undefined} onChange={(e) => set(key, e.target.value)} />
          <span>{f.unit}</span>
        </div>
        {hint ? <span className="th-hint">{hint}</span> : null}
        {err ? (
          <span className="th-err" role="alert">
            {err}
          </span>
        ) : null}
      </div>
    );
  }

  /** A row of choices where exactly one is on. */
  function choice(label: string, name: "archetype" | "payKind" | "fscCut", options: Array<{ key: string; label: string }>, err?: string) {
    return (
      <div className="th-field" role="group" aria-label={label}>
        <span className="th-label">{label}</span>
        <div className="cp-seg">
          {options.map((o) => (
            <button key={o.key} type="button" aria-pressed={values[name] === o.key} onClick={() => set(name, o.key)}>
              {o.label}
            </button>
          ))}
        </div>
        {err ? (
          <span className="th-err" role="alert">
            {err}
          </span>
        ) : null}
      </div>
    );
  }

  function itemise(on: boolean) {
    shown.touch("monthlyInsurance");
    setValues((s) => {
      const sum = ["insuranceLiabilityMonthly", "insurancePhysicalDamageMonthly", "insuranceCargoMonthly", "insuranceGeneralLiabilityMonthly", "insuranceOtherMonthly"].reduce((t, k) => t + (Number((s as Record<string, string>)[k]) || 0), 0);
      if (on) return { ...s, insuranceItemised: "1", insuranceLiabilityMonthly: sum > 0 ? s.insuranceLiabilityMonthly : s.monthlyInsurance };
      // Back to one total: it becomes the sum of what was itemised, so the floor does not move.
      return { ...s, insuranceItemised: "", monthlyInsurance: sum > 0 ? String(sum) : s.monthlyInsurance, insuranceLiabilityMonthly: "", insurancePhysicalDamageMonthly: "", insuranceCargoMonthly: "", insuranceGeneralLiabilityMonthly: "", insuranceOtherMonthly: "" };
    });
  }

  const blurb = COST_ARCHETYPES.find((a) => a.value === live.archetype)?.blurb;
  const targetLabel = live.archetype === "hired_driver" ? "Truck profit target" : "Driver pay target";

  return (
    <form
      className="cp"
      onSubmit={(e) => {
        e.preventDefault();
        shown.tried();
        if (!check.ok) return;
        const w = profileWarnings(check.numbers, check.choices);
        if (w.length > 0) setWarnings(w);
        else save();
      }}>
      <div className="cp-fields">
        <div className="cp-top">
          <p className="tl-note">{isNew ? `Started from typical numbers for a ${typeLabel ?? "truck"}. Change what is different here.` : "Every number a verdict on this truck is measured against."}</p>
          <button
            type="button"
            className="tl-btn sm"
            onClick={() => {
              setValues((s) => ({ ...s, ...industryValues(vehicleType), insuranceItemised: "", insuranceLiabilityMonthly: "", insurancePhysicalDamageMonthly: "", insuranceCargoMonthly: "", insuranceGeneralLiabilityMonthly: "", insuranceOtherMonthly: "" }));
              toast({ text: "Insurance, authority, phone, miles, upkeep and burden are back to typical. Save to keep them.", tone: "ok" });
            }}>
            Fill with typical numbers
          </button>
        </div>

        <h3 className="th-group">Insurance</h3>
        <div className="cp-seg" role="group" aria-label="How insurance is entered" style={{ marginBottom: 10 }}>
          <button type="button" aria-pressed={!live.insuranceItemised} onClick={() => itemise(false)}>
            One total
          </button>
          <button type="button" aria-pressed={live.insuranceItemised} onClick={() => itemise(true)}>
            Itemise
          </button>
        </div>
        {live.insuranceItemised ? (
          <div className="th-grid">
            {field("insuranceLiabilityMonthly")}
            {field("insurancePhysicalDamageMonthly")}
            {field("insuranceCargoMonthly")}
            {field("insuranceGeneralLiabilityMonthly")}
            {field("insuranceOtherMonthly")}
            <div className="th-field">
              <span className="th-label">Total</span>
              <div className="cp-total">{usd(preview?.numbers.monthlyInsurance ?? 0)} a month</div>
            </div>
          </div>
        ) : (
          <div className="th-grid">{field("monthlyInsurance")}</div>
        )}

        <h3 className="th-group">Other fixed bills</h3>
        <div className="th-grid">
          {field("monthlyAuthority")}
          {field("monthlyPhoneSubscriptions")}
          {field("monthlyLoanPayment")}
          {field("truckReplacementMonthly")}
          {field("annualFixedCosts")}
          {field("otherFixedMonthly")}
        </div>

        <h3 className="th-group">Miles and upkeep</h3>
        <div className="th-grid">
          {field("estimatedMonthlyMiles")}
          {field("maintenanceReservePerMile")}
          {field("tireReservePerMile")}
        </div>

        <h3 className="th-group">Fuel</h3>
        <div className="th-grid">{field("lastFuelPricePerGallon", { hint: `${truckMpgInfo.typical ? `No mpg is set on the truck, so a typical ${truckMpgInfo.mpg} mpg is used.` : `Uses the truck's ${truckMpgInfo.mpg} mpg.`} Blank gives no verdict until fuel is known.` })}</div>
        <LiveFuelPrice fuel={fuelKindOf(fuelType)} origin={homeBase ?? ""} typed={values.lastFuelPricePerGallon} onUse={(price) => set("lastFuelPricePerGallon", price)} idle={homeBase ? "Looks up this week's price for the truck's home base region. It fills the box; you still save." : "No home base is set, so this is the national price. It fills the box; you still save."} />

        <h3 className="th-group">Who drives</h3>
        {choice("This truck is run", "archetype", COST_ARCHETYPES.map((a) => ({ key: a.value, label: a.value === "hired_driver" ? "By a paid driver" : a.value === "leased_on" ? "Leased on to a carrier" : "By its owner" })), errors.archetype)}
        {blurb ? <p className="tl-note" style={{ marginTop: 6 }}>{live.archetype === "hired_driver" ? "A driver you pay runs it. Their pay and payroll burden count in every verdict." : live.archetype === "leased_on" ? "It runs under another carrier's authority, and the carrier keeps a cut." : "The owner drives it. No labour line in the verdict."}</p> : null}
        <div className="th-grid" style={{ marginTop: 12 }}>
          {field("driverHourlyTarget", { label: targetLabel, hint: live.archetype === "hired_driver" ? "What the truck should clear for you an hour, after the driver is paid." : undefined })}
          {live.archetype === "hired_driver" ? (
            <>
              {choice("Driver is paid", "payKind", [{ key: "hourly", label: "By the hour" }, { key: "cpm", label: "Per mile" }], errors.payKind)}
              {live.payKind === "cpm" ? field("hiredDriverRatePerMile") : field("hiredDriverHourlyRate")}
              {field("laborBurdenPct")}
            </>
          ) : null}
          {live.archetype === "leased_on" ? (
            <>
              {field("carrierCutPct")}
              {choice("Does the carrier take its cut from fuel surcharge?", "fscCut", [{ key: "yes", label: "Yes" }, { key: "no", label: "No" }, { key: "not_sure", label: "Not sure" }], errors.fscCut)}
            </>
          ) : null}
          {field("factoringFeePct")}
        </div>
        {live.archetype === "hired_driver" ? <p className="tl-note" style={{ marginTop: 6 }}>A driver&apos;s own usual pay is on the Drivers page; a load&apos;s pay is set when it is assigned.</p> : null}

        <h3 className="th-group">Targets</h3>
        <div className="th-grid">{field("dailyRevenueTarget")}</div>
        <div className="cp-seg" role="group" aria-label="Route minimum" style={{ margin: "14px 0 10px" }}>
          <button type="button" aria-pressed={!live.routeMinimumOn} onClick={() => set("routeMinimumOn", "")}>
            No route minimum
          </button>
          <button type="button" aria-pressed={live.routeMinimumOn} onClick={() => set("routeMinimumOn", "1")}>
            Price routes with a minimum
          </button>
        </div>
        {live.routeMinimumOn ? (
          <div className="th-grid">
            {field("routeBaseMinimum")}
            {field("routeIncludedMiles")}
            {field("routeIncludedStops")}
            {field("routeOveragePerMile")}
            {field("routeOveragePerStop")}
          </div>
        ) : null}

        <h3 className="th-group">Detention</h3>
        <div className="th-grid">
          {field("detentionHourlyRate")}
          {field("freeGraceMinutes")}
        </div>

        <div className="th-actions">
          <button type="submit" className="tl-btn primary" disabled={pending || (!isNew && unchanged)} aria-busy={pending || undefined}>
            {pending ? "Saving…" : stored ? "Save cost profile" : "Create cost profile"}
          </button>
          {unchanged && stored ? <span className="tl-sub">Saved.</span> : null}
          {shown.active && !check.ok ? <span className="tl-sub">Some fields need attention.</span> : null}
        </div>
      </div>

      <aside className="cp-preview" aria-live="polite" aria-label="The floor these costs give">
        <div className="km-label">Break-even floor</div>
        <div className="km-value">{preview ? perMile(preview.floors.breakEvenRpm) : "—"}</div>
        <div className="cp-was">
          {stored ? <>was {perMile(stored.breakEven)} </> : <>no profile yet </>}
          {preview && stored ? <DeltaChip delta={deltaOf(preview.floors.breakEvenRpm, stored.breakEven, { kind: "pct", lowerIsBetter: true })} /> : null}
        </div>
        <div className="km-label" style={{ marginTop: 16 }}>Survival floor</div>
        <div className="cp-sub">{preview ? perMile(preview.floors.survivalFloorRpm) : "—"} <span>fixed costs only, nothing for upkeep</span></div>
        {summary ? (
          <>
            <dl className="tl-kv" style={{ marginTop: 16 }}>
              {summary.hero.map((m) => (
                <React.Fragment key={m.key}>
                  <dt>{m.kicker}</dt>
                  <dd>
                    {m.value}
                    <span className="tl-sub">{m.unit}</span>
                  </dd>
                </React.Fragment>
              ))}
            </dl>
            {summary.buildUp ? (
              <details className="cp-build">
                <summary>
                  What builds it <span className="tl-sub">{summary.buildUp.sub}</span>
                </summary>
                <dl className="tl-kv">
                  {summary.buildUp.lines.map((l) => (
                    <React.Fragment key={l.key}>
                      <dt>{l.label}</dt>
                      <dd>{l.value}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </details>
            ) : null}
          </>
        ) : (
          <p className="tl-note" style={{ marginTop: 12 }}>Type the miles driven in a month to see the floor.</p>
        )}
        <p className="tl-note" style={{ marginTop: 14 }}>
          {openLoads > 0 ? `${openLoads} open ${openLoads === 1 ? "load is" : "loads are"} on this truck and will be judged on the new floor. ` : ""}
          Finished loads keep the floor they were accepted at. Each verdict adds fuel for the load&apos;s own miles{live.archetype === "hired_driver" ? " and the driver's pay" : ""} on top.
        </p>
      </aside>

      <ConfirmDialog open={warnings != null} onClose={() => setWarnings(null)} onConfirm={save} eyebrow="Before saving" title="Check these numbers" confirmLabel="Save as typed">
        <ul className="cp-warn">{warnings?.map((w) => <li key={w}>{w}</li>)}</ul>
        <p className="tl-note">A typo is the usual cause: a comma read as a decimal point, or 100 typed for 10. Go back to change them, or save them as typed.</p>
      </ConfirmDialog>
    </form>
  );
}
