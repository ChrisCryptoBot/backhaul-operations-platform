"use client";

import Link from "next/link";
import React from "react";
import type { MarketQuote } from "@/server/dat/market-rate";
import type { PeriodRollup, VarianceEntryDto, VarianceLogView } from "@/server/dat/variance-log";
import { EmptyState } from "@/components/ui/empty-state";
import { UndoToast, useToast } from "@/components/ui/toast";
import { LockIcon, LoopIcon } from "@/components/icons";
import { CityAutocomplete } from "./city-autocomplete";

type Equipment = "VAN" | "REEFER" | "FLATBED";
type RateType = "SPOT" | "CONTRACT";
type Band = "ABOVE" | "AT" | "BELOW";

const EQUIPMENT: Equipment[] = ["VAN", "REEFER", "FLATBED"];
const RATE_TYPES: RateType[] = ["SPOT", "CONTRACT"];

const BAND_META: Record<Band, { variant: "ok" | "near" | "below"; label: string }> = {
  ABOVE: { variant: "ok", label: "Above market" },
  AT: { variant: "near", label: "At market" },
  BELOW: { variant: "below", label: "Below market" }
};

function classifyBand(pct: number, threshold: number): Band {
  if (pct > threshold) return "ABOVE";
  if (pct < -threshold) return "BELOW";
  return "AT";
}

const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const perMile = (n: number) => `$${n.toFixed(2)}`;
const signedPerMile = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;
const signedMoney = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;
const signedPct = (n: number) => `${n >= 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(1)}%`;

interface Props {
  initialLog: VarianceLogView;
  canWrite: boolean;
  datLive: boolean;
}

export function MarketVarianceManager({ initialLog, canWrite, datLive }: Props) {
  const [log, setLog] = React.useState<VarianceLogView>(initialLog);
  const [rollupUnit, setRollupUnit] = React.useState<"day" | "week">("week");
  const { toast, show, clear } = useToast();

  // Lane form.
  const [originCity, setOriginCity] = React.useState("");
  const [originState, setOriginState] = React.useState("");
  const [destCity, setDestCity] = React.useState("");
  const [destState, setDestState] = React.useState("");
  const [equipment, setEquipment] = React.useState<Equipment>("VAN");
  const [rateType, setRateType] = React.useState<RateType>("SPOT");

  const [quote, setQuote] = React.useState<MarketQuote | null>(null);
  const [quoteBusy, setQuoteBusy] = React.useState(false);
  const [quoteError, setQuoteError] = React.useState<string | null>(null);

  // Negotiation calculator.
  const [miles, setMiles] = React.useState("");
  const [negMode, setNegMode] = React.useState<"total" | "permile">("total");
  const [negValue, setNegValue] = React.useState("");
  // Market rate is the value FROM DAT iQ — auto-filled by the API when connected,
  // otherwise typed in manually. It drives the variance (never a hidden formula).
  const [marketMode, setMarketMode] = React.useState<"total" | "permile">("permile");
  const [marketInput, setMarketInput] = React.useState("");
  const [marketSource, setMarketSource] = React.useState<"manual" | "dat" | "mock">("manual");
  const [notes, setNotes] = React.useState("");
  const [logBusy, setLogBusy] = React.useState(false);
  const [logError, setLogError] = React.useState<string | null>(null);

  const laneReady = originCity.trim() && originState.trim() && destCity.trim() && destState.trim();

  async function runLookup(forceRefresh = false) {
    if (!laneReady) {
      setQuoteError("Enter both origin and destination city + state.");
      return;
    }
    setQuoteBusy(true);
    setQuoteError(null);
    try {
      const res = await fetch("/api/market-rate/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originCity: originCity.trim(),
          originState: originState.trim(),
          destCity: destCity.trim(),
          destState: destState.trim(),
          equipment,
          rateType,
          forceRefresh
        })
      });
      const payload = (await res.json().catch(() => null)) as { quote?: MarketQuote; error?: string } | null;
      if (!res.ok || !payload?.quote) {
        throw new Error(payload?.error ?? "Lookup failed.");
      }
      setQuote(payload.quote);
      // Pre-fill the (editable) market-rate field from the lookup, in $/mi. The
      // coordinator can override it with the exact number from their DAT iQ screen.
      setMarketInput(payload.quote.allInPerMile.toFixed(2));
      setMarketMode("permile");
      setMarketSource(payload.quote.isMock ? "mock" : "dat");
      // Seed miles from the quote when the field is empty and DAT/road miles are known.
      if (payload.quote.mileage != null && miles.trim() === "") {
        setMiles(String(payload.quote.mileage));
      }
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : "Lookup failed.");
    } finally {
      setQuoteBusy(false);
    }
  }

  // Live variance (client mirror of the server math) for instant feedback while typing.
  const milesNum = Number(miles) || (quote?.mileage ?? 0);
  const negNum = Number(negValue) || 0;
  const negotiatedTotal = negMode === "total" ? negNum : negNum * milesNum;
  // Market rate → per-mile, from whichever unit the user entered it in.
  const marketNum = Number(marketInput) || 0;
  const marketPerMile = marketMode === "permile" ? marketNum : milesNum > 0 ? marketNum / milesNum : 0;
  const variance = React.useMemo(() => {
    if (milesNum <= 0 || negotiatedTotal <= 0 || marketPerMile <= 0) return null;
    const negotiatedPerMile = negotiatedTotal / milesNum;
    const marketTotal = marketPerMile * milesNum;
    const varTotal = negotiatedTotal - marketTotal;
    const varPct = marketTotal !== 0 ? varTotal / marketTotal : 0;
    return {
      negotiatedPerMile,
      marketPerMile,
      marketTotal,
      variancePerMile: negotiatedPerMile - marketPerMile,
      varianceTotal: varTotal,
      variancePct: varPct,
      band: classifyBand(varPct, log.bandPct / 100)
    };
  }, [milesNum, negotiatedTotal, marketPerMile, log.bandPct]);

  async function logEntry() {
    if (!variance) return;
    setLogBusy(true);
    setLogError(null);
    try {
      const res = await fetch("/api/market-variance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originCity: originCity.trim(),
          originState: originState.trim(),
          destCity: destCity.trim(),
          destState: destState.trim(),
          equipment,
          rateType,
          negotiatedTotal,
          miles: milesNum,
          milesSource: quote?.mileage != null ? "dat" : "manual",
          marketPerMile, // the DAT/manual market rate that drove the variance
          quoteId: quote?.id ?? null,
          notes: [notes.trim(), marketSource === "manual" ? "market: manual DAT entry" : null].filter(Boolean).join(" · ") || null
        })
      });
      const payload = (await res.json().catch(() => null)) as { entry?: VarianceEntryDto; error?: string } | null;
      if (!res.ok || !payload?.entry) {
        throw new Error(payload?.error ?? "Log failed.");
      }
      // Refresh the tracker so weekly rollups + brief recompute.
      const refreshed = await fetch("/api/market-variance", { method: "GET" });
      const view = (await refreshed.json().catch(() => null)) as VarianceLogView | null;
      if (view) setLog(view);
      setNotes("");
      show({ message: `Logged ${BAND_META[payload.entry.band].label.toLowerCase()} · ${signedPct(payload.entry.variancePct)}` });
    } catch (error) {
      setLogError(error instanceof Error ? error.message : "Log failed.");
    } finally {
      setLogBusy(false);
    }
  }

  return (
    <div className="db-ref">
      <div className="db-ref-body">
        <div className="db-ref-head">
          <div>
            <h2 className="db-ref-h">Market Variance</h2>
            <div className="db-ref-desc">
              Market rate comes from DAT iQ — auto-filled when the API is connected, or type it in from your DAT screen. See the disparity vs your negotiated rate instantly, then log it. Above market is a win (we&apos;re the carrier).
            </div>
          </div>
          <div className="db-ref-actions">
            <span className={`db-flag ${datLive ? "muted" : "warn"}`} title={datLive ? "Live DAT API key configured" : "No DAT key — using mock rates"}>
              {datLive ? "Live DAT" : "Mock data"}
            </span>
            <Link href="/" className="db-btn db-btn-ghost">Back to board</Link>
          </div>
        </div>

        {/* ── Negotiation tool ─────────────────────────────────────────────── */}
        <div className="db-fallback-card" style={{ marginBottom: 18 }}>
          <div className="db-form-grid">
            <label className="db-field-label">
              Origin city
              <CityAutocomplete
                className="db-input"
                ariaLabel="Origin city"
                cityValue={originCity}
                placeholder="Type a city, e.g. Syracuse"
                onCityChange={setOriginCity}
                onPick={(city, state) => {
                  setOriginCity(city);
                  setOriginState(state);
                }}
              />
            </label>
            <label className="db-field-label">
              Origin state
              <input className="db-input" value={originState} placeholder="NY" maxLength={2} onChange={(e) => setOriginState(e.target.value.toUpperCase())} />
            </label>
            <label className="db-field-label">
              Destination city
              <CityAutocomplete
                className="db-input"
                ariaLabel="Destination city"
                cityValue={destCity}
                placeholder="Type a city, e.g. Philadelphia"
                onCityChange={setDestCity}
                onPick={(city, state) => {
                  setDestCity(city);
                  setDestState(state);
                }}
              />
            </label>
            <label className="db-field-label">
              Destination state
              <input className="db-input" value={destState} placeholder="PA" maxLength={2} onChange={(e) => setDestState(e.target.value.toUpperCase())} />
            </label>
            <label className="db-field-label">
              Equipment
              <select className="db-input" value={equipment} onChange={(e) => setEquipment(e.target.value as Equipment)}>
                {EQUIPMENT.map((eq) => <option key={eq} value={eq}>{eq}</option>)}
              </select>
            </label>
            <label className="db-field-label">
              Rate type
              <select className="db-input" value={rateType} onChange={(e) => setRateType(e.target.value as RateType)}>
                {RATE_TYPES.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
              </select>
            </label>
            <div className="db-form-full" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button type="button" className="db-btn primary" disabled={quoteBusy || !laneReady} aria-busy={quoteBusy} onClick={() => void runLookup(false)}>
                {quoteBusy ? "Fetching…" : "Get market rate"}
              </button>
              {quote ? (
                <button type="button" className="db-btn db-btn-ghost" disabled={quoteBusy} onClick={() => void runLookup(true)} title="Force a fresh DAT pull">
                  <LoopIcon size={14} /> Refresh
                </button>
              ) : null}
              {quoteError ? <span className="db-upload-error" style={{ margin: 0 }}>{quoteError}</span> : null}
            </div>
          </div>

          {quote ? (
            <div className="db-mv-quote" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-end" }}>
              <div>
                <div className="db-set-eyebrow">DAT lookup · all-in → pre-filled below</div>
                <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>{perMile(quote.allInPerMile)}<span className="dim" style={{ fontSize: 13, fontWeight: 400 }}>/mi</span></div>
                <div className="dim mono" style={{ fontSize: 12 }}>
                  line-haul {perMile(quote.ratePerMileAvg)} + fuel {quote.fuelPerMile != null ? perMile(quote.fuelPerMile) : "—"}
                </div>
              </div>
              <div className="dim mono" style={{ fontSize: 12, lineHeight: 1.7 }}>
                <div>range {perMile(quote.ratePerMileLow)} – {perMile(quote.ratePerMileHigh)}</div>
                <div>miles {quote.mileage != null ? quote.mileage : "—"} · reports {quote.reportCount ?? "—"}</div>
                <div>
                  <span className={`db-flag ${quote.isMock ? "warn" : "muted"}`} style={{ marginRight: 6 }}>{quote.isMock ? "MOCK" : "DAT"}</span>
                  as-of {new Date(quote.fetchedAt).toLocaleString()} {quote.isStale ? "· stale, refresh" : ""}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* ── Live variance calculator ─────────────────────────────────────── */}
        {laneReady ? (
          <div className="db-fallback-card" style={{ marginBottom: 22 }}>
            <div className="db-form-grid">
              <label className="db-field-label">
                Trip miles
                <input className="db-input mono" inputMode="decimal" value={miles} placeholder="e.g. 250" onChange={(e) => setMiles(e.target.value)} />
              </label>
              <label className="db-field-label">
                Market rate ({marketMode === "total" ? "total $" : "$/mi"}) · {marketSource === "manual" ? "manual" : marketSource === "mock" ? "mock" : "DAT"}
                <input className="db-input mono" inputMode="decimal" value={marketInput} placeholder={marketMode === "total" ? "from DAT iQ, e.g. 4778" : "from DAT iQ, e.g. 3.20"} onChange={(e) => { setMarketInput(e.target.value); setMarketSource("manual"); }} />
              </label>
              <div className="db-field-label">
                Market as
                <div style={{ display: "flex", gap: 6, paddingTop: 4 }}>
                  <button type="button" className={`db-btn db-btn-mini${marketMode === "total" ? " primary" : " db-btn-ghost"}`} onClick={() => setMarketMode("total")}>Total $</button>
                  <button type="button" className={`db-btn db-btn-mini${marketMode === "permile" ? " primary" : " db-btn-ghost"}`} onClick={() => setMarketMode("permile")}>$/mi</button>
                </div>
              </div>
              <label className="db-field-label">
                Negotiated rate ({negMode === "total" ? "total $" : "$/mi"})
                <input className="db-input mono" inputMode="decimal" value={negValue} placeholder={negMode === "total" ? "e.g. 3200" : "e.g. 2.35"} onChange={(e) => setNegValue(e.target.value)} />
              </label>
              <div className="db-field-label">
                Negotiated as
                <div style={{ display: "flex", gap: 6, paddingTop: 4 }}>
                  <button type="button" className={`db-btn db-btn-mini${negMode === "total" ? " primary" : " db-btn-ghost"}`} onClick={() => setNegMode("total")}>Total $</button>
                  <button type="button" className={`db-btn db-btn-mini${negMode === "permile" ? " primary" : " db-btn-ghost"}`} onClick={() => setNegMode("permile")}>$/mi</button>
                </div>
              </div>
            </div>

            {variance ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", marginTop: 12 }}>
                <span className={`db-lane-status ${BAND_META[variance.band].variant} mono`} style={{ fontSize: 14 }}>
                  {BAND_META[variance.band].label} · {signedPct(variance.variancePct)}
                </span>
                <div className="mono" style={{ fontSize: 13, lineHeight: 1.7 }}>
                  <div>Per-mile: you {perMile(variance.negotiatedPerMile)} vs market {perMile(variance.marketPerMile)} → <strong>{signedPerMile(variance.variancePerMile)}/mi</strong></div>
                  <div>Total: you {money(negotiatedTotal)} vs market {money(variance.marketTotal)} → <strong>{signedMoney(variance.varianceTotal)}</strong></div>
                </div>
                {canWrite ? (
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                    <input className="db-input" style={{ width: 200 }} placeholder="Note (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
                    <button type="button" className="db-btn primary" disabled={logBusy} aria-busy={logBusy} onClick={() => void logEntry()}>
                      {logBusy ? "Logging…" : "Log to tracker"}
                    </button>
                  </div>
                ) : (
                  <span className="db-ro-chip" style={{ marginLeft: "auto" }}><LockIcon size={13} /> Read-only</span>
                )}
              </div>
            ) : (
              <p className="dim" style={{ marginTop: 10, fontSize: 13 }}>Enter trip miles, the DAT market rate, and your negotiated rate to see the variance.</p>
            )}
            {logError ? <p className="db-upload-error">{logError}</p> : null}
          </div>
        ) : null}

        {/* ── Executive brief ──────────────────────────────────────────────── */}
        {log.brief?.currentWeek ? (
          <div className="db-mv-brief" style={{ marginBottom: 14, fontSize: 13 }}>
            <span className="db-set-eyebrow">This week ({log.brief.currentWeek.period})</span>{" "}
            <span className="mono">
              {log.brief.currentWeek.entryCount} loads · revenue {money(log.brief.currentWeek.negotiatedTotal)} · portfolio {signedPct(log.brief.currentWeek.variancePct)} vs market
              {log.brief.priorWeek ? (
                <> · WoW {signedMoney(log.brief.revenueDelta)} ({log.brief.volumeDelta >= 0 ? "+" : ""}{log.brief.volumeDelta} loads)</>
              ) : null}
            </span>
          </div>
        ) : null}

        {/* ── Tracker table ────────────────────────────────────────────────── */}
        {log.entries.length === 0 ? (
          <EmptyState
            icon={<LoopIcon size={22} />}
            title="No logged negotiations yet"
            copy="Look up a lane, enter a negotiated rate, and log it — the variance history builds here."
          />
        ) : (
          <div className="db-card-table">
            <table className="db-table">
              <thead>
                <tr>
                  <th>Lane</th>
                  <th style={{ width: 70 }}>Equip</th>
                  <th className="right" style={{ width: 80 }}>Miles</th>
                  <th className="right" style={{ width: 100 }}>Negotiated</th>
                  <th className="right" style={{ width: 100 }}>Market</th>
                  <th className="right" style={{ width: 110 }}>Variance</th>
                  <th style={{ width: 150 }}>Status</th>
                  <th style={{ width: 130 }}>When</th>
                </tr>
              </thead>
              <tbody>
                {log.entries.map((e, i) => (
                  <tr key={e.id} className={`db-row${i % 2 ? " odd" : ""}`}>
                    <td className="strong">{e.originCity}, {e.originState} → {e.destCity}, {e.destState}</td>
                    <td className="dim mono">{e.equipment}</td>
                    <td className="right mono num">{e.miles}</td>
                    <td className="right mono num">{money(e.negotiatedTotal)}<div className="dim" style={{ fontSize: 11 }}>{perMile(e.negotiatedPerMile)}/mi</div></td>
                    <td className="right mono num">{money(e.marketTotal)}<div className="dim" style={{ fontSize: 11 }}>{perMile(e.marketPerMile)}/mi</div></td>
                    <td className="right mono num">{signedMoney(e.varianceTotal)}<div className="dim" style={{ fontSize: 11 }}>{signedPct(e.variancePct)}</div></td>
                    <td><span className={`db-lane-status ${BAND_META[e.band].variant} mono`}>{BAND_META[e.band].label}</span></td>
                    <td className="dim mono" style={{ fontSize: 12 }}>{new Date(e.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(() => {
          const rollups: PeriodRollup[] = rollupUnit === "day" ? log.daily : log.weekly;
          if (rollups.length === 0) return null;
          return (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "18px 0 8px" }}>
                <h3 className="db-set-eyebrow" style={{ margin: 0 }}>Trend</h3>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" className={`db-btn db-btn-mini${rollupUnit === "day" ? " primary" : " db-btn-ghost"}`} onClick={() => setRollupUnit("day")}>Day</button>
                  <button type="button" className={`db-btn db-btn-mini${rollupUnit === "week" ? " primary" : " db-btn-ghost"}`} onClick={() => setRollupUnit("week")}>Week</button>
                </div>
              </div>
              <div className="db-card-table">
                <table className="db-table">
                  <thead>
                    <tr>
                      <th>{rollupUnit === "day" ? "Day" : "Week"}</th>
                      <th className="right" style={{ width: 70 }}>Loads</th>
                      <th className="right" style={{ width: 110 }}>Revenue</th>
                      <th className="right" style={{ width: 120 }}>vs Market</th>
                      <th style={{ width: 160 }}>Above / At / Below</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rollups.map((p, i) => (
                      <tr key={p.period} className={`db-row${i % 2 ? " odd" : ""}`}>
                        <td className="strong mono">{p.period}</td>
                        <td className="right mono num">{p.entryCount}</td>
                        <td className="right mono num">{money(p.negotiatedTotal)}</td>
                        <td className="right mono num">{signedPct(p.variancePct)}</td>
                        <td className="mono dim">{p.aboveCount} / {p.atCount} / {p.belowCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}
      </div>

      <UndoToast toast={toast} onDismiss={clear} />
    </div>
  );
}
