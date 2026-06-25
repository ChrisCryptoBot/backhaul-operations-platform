"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import React from "react";
import { SearchIcon } from "@/components/icons";
import { useTheme, AccentToggle } from "@/components/shell/theme";
import type { ReviewRateConfirmation } from "@/server/review";

interface ReviewPanelProps {
  initial: ReviewRateConfirmation;
  regionId: string;
}

interface ActionResponse {
  reviewDecision?: string;
  error?: string;
}

function toDisplayEntries(payload: Record<string, unknown> | null): Array<{ key: string; value: string }> {
  if (!payload) {
    return [];
  }
  return Object.entries(payload)
    .slice(0, 24)
    .map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value)
    }));
}

export function ReviewPanel({ initial, regionId }: ReviewPanelProps) {
  const pathname = usePathname();
  const [review, setReview] = React.useState<ReviewRateConfirmation>(initial);
  const [reason, setReason] = React.useState("");
  const [exceptionMode, setExceptionMode] = React.useState(false);
  const [confirmReject, setConfirmReject] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const { theme: themeMode, toggleTheme } = useTheme();

  const refreshReview = React.useCallback(async () => {
    const response = await fetch(
      `/api/review/${encodeURIComponent(review.id)}?regionId=${encodeURIComponent(regionId)}`,
      { cache: "no-store" }
    );
    if (!response.ok) {
      return;
    }
    const payload = (await response.json().catch(() => null)) as ReviewRateConfirmation | null;
    if (payload) {
      setReview(payload);
    }
  }, [review.id, regionId]);

  const onReject = React.useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/review/${encodeURIComponent(review.id)}?regionId=${encodeURIComponent(regionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", reason: reason.trim() || undefined })
      });
      const payload = (await response.json().catch(() => null)) as ActionResponse | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? "Unable to reject review.");
      }
      setMessage(`Rejected with decision ${payload?.reviewDecision ?? "REJECTED"}.`);
      setConfirmReject(false);
      await refreshReview();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to reject review.");
    } finally {
      setBusy(false);
    }
  }, [reason, refreshReview, review.id, regionId]);

  const displayEntries = React.useMemo(() => toDisplayEntries(review.extractedPayload), [review.extractedPayload]);
  const reasonTrimmed = reason.trim();
  const reviewIsFinal = Boolean(review.loadId) || review.reviewDecision === "REJECTED";
  const canReject = !busy && !reviewIsFinal && exceptionMode && reasonTrimmed.length > 0;
  const boardHref = review.loadId
    ? `/?loadId=${encodeURIComponent(review.loadId)}&regionId=${encodeURIComponent(regionId)}`
    : `/?regionId=${encodeURIComponent(regionId)}`;
  const dashboardHref = `/dashboard?regionId=${encodeURIComponent(regionId)}`;
  const reviewHref = `/review?rateConfirmationId=${encodeURIComponent(review.id)}&regionId=${encodeURIComponent(regionId)}`;

  React.useEffect(() => {
    setConfirmReject(false);
  }, [exceptionMode, reasonTrimmed]);

  const onRejectPress = React.useCallback(async () => {
    if (!canReject) {
      return;
    }
    if (!confirmReject) {
      setConfirmReject(true);
      setMessage("Click Reject again to confirm this exception decision.");
      return;
    }
    await onReject();
  }, [canReject, confirmReject, onReject]);

  function formatStamp(value: string | null): string {
    if (!value) {
      return "-";
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return parsed.toLocaleString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  return (
    <div className="db-root db-app" data-theme={themeMode}>
      <header className="db-topbar">
        <div className="db-brand">
          <div className="db-brand-text">
            <span className="db-brand-name">
              <span className="db-brand-name-accent">BACKHAUL</span> BUCKET
            </span>
            <span className="db-region-badge mono">REVIEW</span>
          </div>
        </div>
        <nav className="db-topnav">
          <Link href={boardHref} className={`db-topnav-item${pathname === "/" ? " active" : ""}`}>
            Daily Tracker
          </Link>
          <Link href={dashboardHref} className={`db-topnav-item${pathname === "/dashboard" ? " active" : ""}`}>
            KPI Dashboard
          </Link>
          <Link href={reviewHref} className={`db-topnav-item${(pathname ?? "").startsWith("/review") ? " active" : ""}`}>
            Review
          </Link>
          <span className="db-topnav-item disabled" title="Coming soon">
            Lanes
          </span>
          <span className="db-topnav-item disabled" title="Coming soon">
            Brokers
          </span>
          <span className="db-topnav-item disabled" title="Coming soon">
            Audit
          </span>
        </nav>
        <div className="db-topbar-right">
          <button className="db-btn db-btn-ghost db-btn-icon" title="Search" type="button" aria-label="Search">
            <SearchIcon size={14} />
          </button>
          <AccentToggle />
          <button
            type="button"
            className="db-btn db-theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${themeMode === "light" ? "dark" : "light"} mode`}
          >
            {themeMode === "light" ? "Dark mode" : "Light mode"}
          </button>
          <div className="db-avatar">CM</div>
        </div>
      </header>

      <main className="db-review-main db-review-content">
        <header className="db-review-header">
          <div>
            <h1 className="db-review-title">Review Queue</h1>
            <p className="db-review-subtitle">Exceptions workspace for uploaded rate confirmations.</p>
          </div>
          <div className="db-review-badges" aria-label="Review metadata">
            <span className="db-pill db-pill-pod">PARSE: {review.parseState}</span>
            {review.parseConfidence !== null ? (
              <span
                className={`db-pill ${
                  review.parseConfidence >= 0.85
                    ? "db-pill-completed"
                    : review.parseConfidence >= 0.6
                      ? "db-pill-pod"
                      : "db-pill-failed"
                }`}
                title="Overall parse confidence"
              >
                CONFIDENCE: {Math.round(review.parseConfidence * 100)}%
              </span>
            ) : null}
            <span className={`db-pill ${review.reviewDecision === "REJECTED" ? "db-pill-failed" : "db-pill-completed"}`}>
              DECISION: {review.reviewDecision}
            </span>
            {review.loadId ? <span className="db-pill db-pill-delivered">LOAD: {review.loadId}</span> : null}
          </div>
        </header>

        <section className="db-review-grid">
          <article className="db-review-card">
            <div className="db-review-card-head">
              <h2 className="db-review-card-title">Rate Confirmation</h2>
              <a className="db-btn db-btn-mini" href={review.sourceFileUrl} target="_blank" rel="noreferrer">
                Open source file
              </a>
            </div>
            <dl className="db-review-meta">
              <div>
                <dt>Rate confirmation ID</dt>
                <dd className="mono">{review.id}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatStamp(review.createdAt)}</dd>
              </div>
              <div>
                <dt>Last updated</dt>
                <dd>{formatStamp(review.updatedAt)}</dd>
              </div>
              <div>
                <dt>Reviewed</dt>
                <dd>{formatStamp(review.reviewedAt)}</dd>
              </div>
              <div>
                <dt>Reviewed by</dt>
                <dd className="mono">{review.reviewedById ?? "-"}</dd>
              </div>
            </dl>
            {review.reviewReason ? (
              <p className="db-uistate-copy">
                <strong>Prior reason:</strong> {review.reviewReason}
              </p>
            ) : null}
          </article>

          <article className="db-review-card">
            <div className="db-review-card-head">
              <h2 className="db-review-card-title">Extracted Payload</h2>
              <span className="db-uistate-copy">{displayEntries.length} fields shown</span>
            </div>
            <div className="db-review-table-wrap">
              {displayEntries.length === 0 ? (
                <p className="db-uistate-copy">No extracted payload available.</p>
              ) : (
                <table className="db-table compact">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayEntries.map((entry) => (
                      <tr key={entry.key}>
                        <td className="mono">{entry.key}</td>
                        <td>{entry.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </article>

          <section className="db-review-card db-review-actions">
            <h2 className="db-review-card-title">Exception Decision</h2>
            <p className="db-uistate-copy">
              Upload processing auto-approves valid loads. Use this panel only for correction and rejection exceptions.
            </p>
            <label htmlFor="exception-mode" className="db-review-checkbox">
              <input
                id="exception-mode"
                type="checkbox"
                checked={exceptionMode}
                onChange={(event) => setExceptionMode(event.target.checked)}
                disabled={busy || reviewIsFinal}
              />
              Enable exception workflow
            </label>
            <label htmlFor="reject-reason" className="db-review-label">
              Reject reason
            </label>
            <textarea
              id="reject-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              className="db-review-reason"
              disabled={busy || reviewIsFinal}
              placeholder="Explain why this confirmation should be rejected."
            />
            <div className="db-review-actions-row">
              <button className="db-btn primary" disabled={!canReject} onClick={() => void onRejectPress()}>
                {busy ? "Working..." : "Reject"}
              </button>
              <button
                className="db-btn db-btn-ghost"
                disabled={busy || reviewIsFinal || reason.length === 0}
                onClick={() => {
                  setReason("");
                  setMessage(null);
                  setConfirmReject(false);
                }}
              >
                Clear
              </button>
            </div>
            {review.loadId ? (
              <p className="db-uistate-copy">
                This confirmation is already linked to load <strong>{review.loadId}</strong> and cannot be rejected.
              </p>
            ) : null}
          </section>
        </section>

        <section className="db-review-message" aria-live="polite" aria-atomic="true">
          {message ? <p className="db-uistate-copy">{message}</p> : null}
        </section>
      </main>
    </div>
  );
}
