"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import React from "react";

export default function ManualEntryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const regionId = searchParams.get("regionId") ?? "";
  const [pickupDate, setPickupDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [deliveryDate, setDeliveryDate] = React.useState("");
  const [shipperName, setShipperName] = React.useState("");
  const [receiverName, setReceiverName] = React.useState("");
  const [lineHaulRate, setLineHaulRate] = React.useState("1000");
  const [loadedMiles, setLoadedMiles] = React.useState("200");
  const [puDeadheadMiles, setPuDeadheadMiles] = React.useState("0");
  const [delDeadheadMiles, setDelDeadheadMiles] = React.useState("0");
  const [driverType, setDriverType] = React.useState<"" | "SHUTTLE" | "PTP" | "LTL">("");
  const [fscApplies, setFscApplies] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const boardHref = regionId ? `/?regionId=${encodeURIComponent(regionId)}` : "/";
  const reviewHref = regionId ? `/review?regionId=${encodeURIComponent(regionId)}` : "/review";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/review/manual-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          regionId: regionId || undefined,
          pickupDate,
          deliveryDate: deliveryDate || undefined,
          shipperName: shipperName.trim() || undefined,
          receiverName: receiverName.trim() || undefined,
          lineHaulRate,
          loadedMiles,
          puDeadheadMiles,
          delDeadheadMiles,
          fscApplies,
          driverType: driverType || undefined
        })
      });
      const payload = (await response.json().catch(() => null)) as { error?: string; loadId?: string; regionId?: string } | null;
      if (!response.ok || !payload?.loadId) {
        throw new Error(payload?.error ?? "Manual load entry failed.");
      }
      const nextRegionId = payload.regionId ?? regionId;
      const params = new URLSearchParams();
      if (nextRegionId) {
        params.set("regionId", nextRegionId);
      }
      params.set("loadId", payload.loadId);
      router.push(`/?${params.toString()}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Manual load entry failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="db-root db-fallback-main">
      <section className="db-fallback-card">
        <h1>Manual Entry Recovery</h1>
        <p className="db-uistate-copy">
          Use this fallback when parsing fails but dispatch still needs the load on today&apos;s board.
        </p>
        <form className="db-review-grid" onSubmit={onSubmit}>
          <label className="db-field-label">
            Pickup date
            <input type="date" className="db-input" value={pickupDate} onChange={(event) => setPickupDate(event.target.value)} required />
          </label>
          <label className="db-field-label">
            Delivery date
            <input type="date" className="db-input" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} />
          </label>
          <label className="db-field-label">
            Line haul rate
            <input type="number" min="0.01" step="0.01" className="db-input" value={lineHaulRate} onChange={(event) => setLineHaulRate(event.target.value)} required />
          </label>
          <label className="db-field-label">
            Loaded miles
            <input type="number" min="0.01" step="0.01" className="db-input" value={loadedMiles} onChange={(event) => setLoadedMiles(event.target.value)} required />
          </label>
          <label className="db-field-label">
            PU deadhead miles
            <input type="number" min="0" step="0.01" className="db-input" value={puDeadheadMiles} onChange={(event) => setPuDeadheadMiles(event.target.value)} />
          </label>
          <label className="db-field-label">
            DEL deadhead miles
            <input type="number" min="0" step="0.01" className="db-input" value={delDeadheadMiles} onChange={(event) => setDelDeadheadMiles(event.target.value)} />
          </label>
          <label className="db-field-label">
            Driver type
            <select className="db-input" value={driverType} onChange={(event) => setDriverType(event.target.value as "" | "SHUTTLE" | "PTP" | "LTL")}>
              <option value="">—</option>
              <option value="SHUTTLE">SHUTTLE</option>
              <option value="PTP">PTP</option>
              <option value="LTL">LTL</option>
            </select>
          </label>
          <label className="db-field-label">
            Shipper name
            <input className="db-input" value={shipperName} onChange={(event) => setShipperName(event.target.value)} />
          </label>
          <label className="db-field-label">
            Receiver name
            <input className="db-input" value={receiverName} onChange={(event) => setReceiverName(event.target.value)} />
          </label>
          <label className="db-review-checkbox">
            <input type="checkbox" checked={fscApplies} onChange={(event) => setFscApplies(event.target.checked)} />
            Apply fuel surcharge for this load
          </label>
          {error ? <p className="db-upload-error">{error}</p> : null}
          <div className="db-row-with-actions">
            <button type="submit" className="db-btn primary" disabled={busy}>
              {busy ? "Creating..." : "Create load on board"}
            </button>
            <Link href={boardHref} className="db-btn db-btn-ghost">
              Back to board
            </Link>
            <Link href={reviewHref} className="db-btn db-btn-ghost">
              Back to review
            </Link>
          </div>
        </form>
      </section>
    </main>
  );
}
