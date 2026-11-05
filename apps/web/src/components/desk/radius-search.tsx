"use client";

import React from "react";
import { STATE_FILTERS, type RadarQueryParams, type SearchInfo, type StateKey } from "@/lib/radar-points";
import { RADII, countsText } from "@/lib/radius";
import { useDraft } from "./kit/use-draft";

/**
 * "What is within so many miles of here": a ZIP code, a city and state, or a state, and a radius. The place is read offline from the bundled Census data; anything it cannot read is asked of the
 * metered geocoder. The result line says what was found and how many units are inside. With `filters` the Radar page also gets the kind, state and word filters under it.
 */
type Filters = { kind: RadarQueryParams["kind"]; state: StateKey | ""; q: string };

export function RadiusSearch({
  value,
  info,
  onSearch,
  onClear,
  compact,
  filters,
  onFilters
}: {
  value: { near: string; r: string };
  info: SearchInfo | null;
  /** `r` is null when no radius was typed (a state search then takes its own). */
  onSearch: (near: string, r: number | null) => void;
  onClear: () => void;
  compact?: boolean;
  filters?: Filters;
  onFilters?: (f: Partial<Filters>) => void;
}) {
  const [form, setForm, draft] = useDraft(compact ? "radar:search-compact" : "radar:search", { near: value.near, r: value.r });
  const [word, setWord, wordDraft] = useDraft("radar:filter-word", { q: filters?.q ?? "" });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const near = form.near.trim();
    if (!near) return onClear();
    const r = Number.parseInt(form.r, 10);
    onSearch(near, Number.isFinite(r) && r > 0 ? r : null);
    draft.saved();
  };
  return (
    <div className={compact ? "rs rs-compact" : "rs"}>
      <form className="rs-form" onSubmit={submit} role="search" aria-label="Search by place">
        <label className="tl-field">
          ZIP, city or state
          <input value={form.near} onChange={(e) => setForm({ ...form, near: e.target.value })} placeholder="75201, Dallas TX, or TX" autoComplete="off" maxLength={80} />
        </label>
        <label className="tl-field">
          Miles
          <input value={form.r} onChange={(e) => setForm({ ...form, r: e.target.value })} list="rs-radii" inputMode="numeric" size={5} placeholder="50" maxLength={4} />
          <datalist id="rs-radii">
            {RADII.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </label>
        <button type="submit" className="tl-btn sm">
          Search
        </button>
        {info ? (
          <button
            type="button"
            className="tl-btn ghost sm"
            onClick={() => {
              setForm({ near: "", r: "" });
              draft.discard();
              onClear();
            }}>
            Clear
          </button>
        ) : null}
      </form>
      {info?.ok ? (
        <p className="rs-found" aria-live="polite">
          <b>{info.label}</b> · {info.radius} mi · {countsText(info.trucks, info.trailers)}
          {info.source === "mapbox" ? <span className="rd-sub"> (found by address search)</span> : null}
        </p>
      ) : null}
      {info && !info.ok ? (
        <p className="rs-error" role="alert">
          {info.error}
        </p>
      ) : null}
      {filters && onFilters ? (
        <div className="rs-filters">
          <label className="tl-field">
            Show
            <select value={filters.kind} onChange={(e) => onFilters({ kind: e.target.value as Filters["kind"] })}>
              <option value="all">Trucks and trailers</option>
              <option value="tractor">Trucks only</option>
              <option value="trailer">Trailers only</option>
            </select>
          </label>
          <label className="tl-field">
            State
            <select value={filters.state} onChange={(e) => onFilters({ state: e.target.value as StateKey | "" })}>
              <option value="">Any</option>
              {STATE_FILTERS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="tl-field">
            Name or driver
            <input
              value={word.q}
              onChange={(e) => {
                setWord({ q: e.target.value });
                onFilters({ q: e.target.value });
              }}
              onBlur={() => wordDraft.saved()}
              maxLength={60}
              autoComplete="off"
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
