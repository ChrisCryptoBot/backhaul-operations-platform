"use client";

import React from "react";
import { createPortal } from "react-dom";
import { DOC_LABEL } from "@/lib/documents";
import { sizeLabel } from "@/lib/attachments";
import Link from "next/link";
import { DrawerFrame } from "./drawer-frame";
import { PageHead } from "./ui";
import { Icon } from "./kit/icons";
import type { DocItem, DeliveryStopOption } from "./load-documents";
import { LoadDocuments } from "./load-documents";

export type WorkbenchTab = "route" | "margin" | "docs" | "partners";

interface LoadCockpitProps {
  variant: "drawer" | "page";
  title: string;
  sub: React.ReactNode;
  chips: React.ReactNode;
  fullHref: string;
  footer: React.ReactNode;
  deck: React.ReactNode;

  routeWorkbench: React.ReactNode;
  marginWorkbench: React.ReactNode;
  docsWorkbench: React.ReactNode;
  partnersWorkbench: React.ReactNode;

  docsCount: number;
  alertsCount?: number;
}

export function LoadCockpit({
  variant,
  title,
  sub,
  chips,
  fullHref,
  footer,
  deck,
  routeWorkbench,
  marginWorkbench,
  docsWorkbench,
  partnersWorkbench,
  docsCount,
  alertsCount
}: LoadCockpitProps) {
  const [activeTab, setActiveTabState] = React.useState<WorkbenchTab>(() => {
    if (typeof window !== "undefined") {
      const saved = window.sessionStorage?.getItem("tl_cockpit_tab");
      if (saved === "route" || saved === "margin" || saved === "docs" || saved === "partners") {
        return saved;
      }
    }
    return "route";
  });

  const setActiveTab = React.useCallback((tab: WorkbenchTab) => {
    setActiveTabState(tab);
    if (typeof window !== "undefined") {
      window.sessionStorage?.setItem("tl_cockpit_tab", tab);
    }
  }, []);

  const [copied, setCopied] = React.useState(false);
  const copyLoadNumber = React.useCallback(() => {
    const raw = typeof title === "string" ? title.replace(/^Load\s+/i, "").trim() : "";
    if (raw && typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [title]);

  const headerTitle = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span>{title}</span>
      <button
        type="button"
        className="cp-copy-btn"
        onClick={copyLoadNumber}
        data-copied={copied ? "true" : undefined}
        title={copied ? "Copied load number to clipboard!" : "Copy load number"}
        aria-label="Copy load number">
        <Icon name={copied ? "check" : "copy"} size={13} />
      </button>
    </span>
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".k-scrim")) return; // dialog open
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (isInput) return;

      if (e.key === "1") {
        e.preventDefault();
        setActiveTab("route");
      } else if (e.key === "2") {
        e.preventDefault();
        setActiveTab("margin");
      } else if (e.key === "3") {
        e.preventDefault();
        setActiveTab("docs");
      } else if (e.key === "4") {
        e.preventDefault();
        setActiveTab("partners");
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setActiveTab]);

  const nav = (
    <nav className="cp-nav" role="tablist" aria-label="Load Workbenches">
      <button
        type="button"
        role="tab"
        id="tab-route"
        aria-controls="panel-route"
        aria-selected={activeTab === "route"}
        className="cp-tab-btn"
        onClick={() => setActiveTab("route")}>
        <span>Route & Stops</span>
        <span className="cp-kbd">1</span>
      </button>

      <button
        type="button"
        role="tab"
        id="tab-margin"
        aria-controls="panel-margin"
        aria-selected={activeTab === "margin"}
        className="cp-tab-btn"
        onClick={() => setActiveTab("margin")}>
        <span>Economics & Margin</span>
        <span className="cp-kbd">2</span>
      </button>

      <button
        type="button"
        role="tab"
        id="tab-docs"
        aria-controls="panel-docs"
        aria-selected={activeTab === "docs"}
        className="cp-tab-btn"
        onClick={() => setActiveTab("docs")}>
        <span>Documents & Proof {docsCount > 0 ? `(${docsCount})` : ""}</span>
        <span className="cp-kbd">3</span>
      </button>

      <button
        type="button"
        role="tab"
        id="tab-partners"
        aria-controls="panel-partners"
        aria-selected={activeTab === "partners"}
        className="cp-tab-btn"
        onClick={() => setActiveTab("partners")}>
        <span>Partners & History {alertsCount && alertsCount > 0 ? `(${alertsCount})` : ""}</span>
        <span className="cp-kbd">4</span>
      </button>
    </nav>
  );

  const activeContent = (
    <div className="cp-workbench-area">
      {activeTab === "route" && (
        <div role="tabpanel" id="panel-route" aria-labelledby="tab-route" className="cp-panel">
          {routeWorkbench}
        </div>
      )}
      {activeTab === "margin" && (
        <div role="tabpanel" id="panel-margin" aria-labelledby="tab-margin" className="cp-panel">
          {marginWorkbench}
        </div>
      )}
      {activeTab === "docs" && (
        <div role="tabpanel" id="panel-docs" aria-labelledby="tab-docs" className="cp-panel">
          {docsWorkbench}
        </div>
      )}
      {activeTab === "partners" && (
        <div role="tabpanel" id="panel-partners" aria-labelledby="tab-partners" className="cp-panel">
          {partnersWorkbench}
        </div>
      )}
    </div>
  );

  if (variant === "drawer") {
    return (
      <DrawerFrame
        title={headerTitle}
        sub={sub}
        chips={chips}
        deck={deck}
        nav={nav}
        footer={footer}
        fullHref={fullHref}>
        {activeContent}
      </DrawerFrame>
    );
  }

  return (
    <>
      <PageHead title={title} sub={sub}>
        <Link href="/loads" className="tl-btn">All loads</Link>
      </PageHead>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>{chips}</div>
      {deck ? <div className="cp-deck">{deck}</div> : null}
      <div className="lv-page" style={{ padding: 0, overflow: "visible" }}>
        <div style={{ position: "sticky", top: "var(--db-header-h, 56px)", zIndex: 10, background: "var(--db-bg-rail)", borderBottom: "1px solid var(--db-border-strong)", marginBottom: 16, padding: "0 8px" }}>
          {nav}
        </div>
        {activeContent}
        <div className="dr-foot" style={{ marginTop: "var(--db-5)", border: "1px solid var(--db-border)", borderRadius: "var(--db-r-lg)" }}>
          {footer}
        </div>
      </div>
    </>
  );
}

/**
 * Split Document Workbench: Left side has document items & upload,
 * right side has integrated document inspector / iframe viewer.
 */
export function SplitDocViewer({
  loadId,
  items,
  locked,
  defaultKind = "pod",
  deliveryStops = []
}: {
  loadId: string;
  items: DocItem[];
  locked: string | null;
  defaultKind?: DocItem["kind"];
  deliveryStops?: DeliveryStopOption[];
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(items[0]?.id ?? null);
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);
  const [rotation, setRotation] = React.useState(0);
  const [zoom, setZoom] = React.useState(100);

  // Reset rotation & zoom when switching docs
  React.useEffect(() => {
    setRotation(0);
    setZoom(100);
  }, [selectedId]);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (items.length > 0 && (!selectedId || !items.some((i) => i.id === selectedId))) {
      setSelectedId(items[0].id);
    }
  }, [items, selectedId]);

  const selectedDoc = items.find((i) => i.id === selectedId) ?? null;
  const currentIndex = items.findIndex((i) => i.id === selectedId);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex !== -1 && currentIndex < items.length - 1;

  const goPrev = React.useCallback(() => {
    if (hasPrev) {
      setSelectedId(items[currentIndex - 1].id);
    }
  }, [hasPrev, currentIndex, items]);

  const goNext = React.useCallback(() => {
    if (hasNext) {
      setSelectedId(items[currentIndex + 1].id);
    }
  }, [hasNext, currentIndex, items]);

  // Handle keyboard navigation: Esc closes expanded modal; ArrowLeft/ArrowRight cycles docs
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
      if (isInput) return;

      if (e.key === "Escape" && isExpanded) {
        e.preventDefault();
        setIsExpanded(false);
        return;
      }

      if (e.key === "ArrowLeft") {
        if (hasPrev) {
          e.preventDefault();
          goPrev();
        }
      } else if (e.key === "ArrowRight") {
        if (hasNext) {
          e.preventDefault();
          goNext();
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isExpanded, hasPrev, hasNext, goPrev, goNext]);

  // Lock body scroll when modal is open
  React.useEffect(() => {
    if (isExpanded) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [isExpanded]);

  return (
    <>
      <div className="cp-doc-workbench">
        {/* Document Inspection & Verification Viewer Container */}
        <div className="cp-doc-viewer">
          {/* Top Inspection & Navigation Bar */}
          <div className="cp-doc-viewer-bar">
            {/* Arrows & Document Info */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
              {items.length > 1 ? (
                <div className="cp-doc-arrows">
                  <button
                    type="button"
                    className="dr-btn-icon sm"
                    disabled={!hasPrev}
                    onClick={goPrev}
                    title="Previous document (ArrowLeft)"
                    aria-label="Previous document">
                    <Icon name="chevronLeft" size={14} />
                  </button>
                  <span className="cp-doc-counter">
                    {currentIndex + 1} / {items.length}
                  </span>
                  <button
                    type="button"
                    className="dr-btn-icon sm"
                    disabled={!hasNext}
                    onClick={goNext}
                    title="Next document (ArrowRight)"
                    aria-label="Next document">
                    <Icon name="chevronRight" size={14} />
                  </button>
                </div>
              ) : null}

              {selectedDoc ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <Icon name="document" size={16} />
                  <strong style={{ fontSize: 13, color: "var(--db-fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 }} title={selectedDoc.name}>
                    {selectedDoc.name}
                  </strong>
                  <span className="tl-chip muted sm" style={{ textTransform: "uppercase", fontSize: 10, fontWeight: 700 }}>
                    {DOC_LABEL[selectedDoc.kind] ?? selectedDoc.kind.toUpperCase()}
                  </span>
                  <span className="tl-sub" style={{ fontSize: 11 }}>
                    {sizeLabel(selectedDoc.bytes)}
                  </span>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="document" size={16} />
                  <strong style={{ fontSize: 13, color: "var(--db-fg)" }}>Document Viewer</strong>
                </div>
              )}
            </div>

            {/* Actions: Expand, Download, Tab */}
            {selectedDoc ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, marginLeft: "auto" }}>
                <div className="cp-doc-ctrls">
                <button
                  type="button"
                  className="cp-doc-ctrl-btn"
                  onClick={() => setRotation((prev) => (prev + 90) % 360)}
                  title={`Rotate document 90° clockwise (${rotation}°)`}
                  aria-label="Rotate document">
                  <Icon name="rotate" size={13} />
                </button>
                <button
                  type="button"
                  className="cp-doc-ctrl-btn"
                  disabled={zoom <= 75}
                  onClick={() => setZoom((prev) => Math.max(75, prev - 25))}
                  title="Zoom out"
                  aria-label="Zoom out">
                  <Icon name="zoomOut" size={13} />
                </button>
                <button
                  type="button"
                  className="cp-doc-ctrl-btn"
                  onClick={() => { setZoom(100); setRotation(0); }}
                  title="Reset rotation & zoom"
                  style={{ fontSize: 10, width: "auto", padding: "0 4px", fontWeight: 700 }}>
                  {zoom}%
                </button>
                <button
                  type="button"
                  className="cp-doc-ctrl-btn"
                  disabled={zoom >= 200}
                  onClick={() => setZoom((prev) => Math.min(200, prev + 25))}
                  title="Zoom in"
                  aria-label="Zoom in">
                  <Icon name="zoomIn" size={13} />
                </button>
              </div>

              <button
                  type="button"
                  onClick={() => setIsExpanded(true)}
                  className="tl-btn sm"
                  style={{ fontSize: 11, padding: "3px 8px" }}
                  title="Expand to full page view">
                  Expand ⛶
                </button>
                <a
                  href={`/documents/${selectedDoc.id}?download=1`}
                  download={selectedDoc.name}
                  className="tl-btn ghost sm"
                  style={{ fontSize: 11, padding: "3px 8px" }}
                  title="Download document">
                  Download ↓
                </a>
                <a
                  href={`/documents/${selectedDoc.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="tl-btn ghost sm"
                  style={{ fontSize: 11, padding: "3px 8px" }}
                  title="Open in new browser tab">
                  Tab ↗
                </a>
              </div>
            ) : null}
          </div>

          {/* Multi-Doc Carousel Strip (When >1 doc exists) */}
          {items.length > 1 ? (
            <div className="cp-doc-carousel" role="tablist" aria-label="Load documents list">
              {items.map((doc, idx) => {
                const isActive = doc.id === selectedId;
                return (
                  <button
                    key={doc.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setSelectedId(doc.id)}
                    className="cp-doc-pill"
                    data-active={isActive ? "true" : undefined}
                    title={`${doc.name} (${sizeLabel(doc.bytes)})`}>
                    <Icon name="document" size={13} />
                    <span>
                      {idx + 1}. {DOC_LABEL[doc.kind] ?? doc.kind.toUpperCase()}: {doc.name}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--db-fg-dim)" }}>({sizeLabel(doc.bytes)})</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Preview Iframe or Empty State */}
          {selectedDoc ? (
            <div className="cp-doc-frame-wrap">
              <iframe
                src={`/documents/${selectedDoc.id}`}
                title={selectedDoc.name}
                className="cp-doc-frame"
                style={{
                  transform: rotation !== 0 || zoom !== 100 ? `rotate(${rotation}deg) scale(${zoom / 100})` : undefined,
                  transformOrigin: "center center",
                  transition: "transform 150ms ease"
                }}
              />
            </div>
          ) : (
            <div className="cp-doc-empty">
              <div>
                <Icon name="document" size={36} />
                <p style={{ marginTop: 12, fontSize: 13, color: "var(--db-fg-dim)" }}>
                  No documents kept yet. Add the Rate Confirmation or Proof of Delivery below.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Document Packet & Upload Station Card */}
        <div className="cp-doc-packet">
          <div className="cp-doc-packet-head">
            <h4>Document Packet & Uploads ({items.length})</h4>
            <span style={{ fontSize: 11, color: "var(--db-fg-dim)" }}>
              Rate Confirmations, Bills of Lading & Proof of Delivery
            </span>
          </div>

          <LoadDocuments
            loadId={loadId}
            items={items}
            locked={locked}
            defaultKind={defaultKind}
            deliveryStops={deliveryStops}
            selectedId={selectedId}
            onSelectDoc={(d) => setSelectedId(d.id)}
            onDocClick={(d) => {
              setSelectedId(d.id);
              setIsExpanded(true);
            }}
          />
        </div>
      </div>

      {/* Full-Page Expanded Document Modal Overlay (Portaled directly to document.body) */}
      {isExpanded && selectedDoc && mounted
        ? createPortal(
            <div className="cp-doc-modal" role="dialog" aria-modal="true" aria-label={selectedDoc.name}>
              <div className="cp-doc-modal-bar">
                {/* Left: Document details */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                  <div className="cp-doc-modal-icon">
                    <Icon name="document" size={20} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: 14,
                          color: "var(--db-fg)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: "min(45vw, 520px)"
                        }}
                        title={selectedDoc.name}>
                        {selectedDoc.name}
                      </div>
                      <span className="tl-chip muted sm" style={{ textTransform: "uppercase", fontWeight: 700, fontSize: 10 }}>
                        {DOC_LABEL[selectedDoc.kind] ?? selectedDoc.kind.toUpperCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--db-fg-dim)", marginTop: 2 }}>
                      Uploaded {selectedDoc.when} by {selectedDoc.by} · {sizeLabel(selectedDoc.bytes)}
                      {selectedDoc.stop ? ` · ${selectedDoc.stop}` : ""}
                    </div>
                  </div>
                </div>

                {/* Center: Multi-document arrows */}
                {items.length > 1 ? (
                  <div className="cp-doc-arrows" style={{ flexShrink: 0 }}>
                    <button
                      type="button"
                      className="tl-btn sm"
                      disabled={!hasPrev}
                      onClick={goPrev}
                      title="Previous document (ArrowLeft)"
                      aria-label="Previous document">
                      <Icon name="chevronLeft" size={14} />
                      <span>Prev</span>
                    </button>
                    <span className="cp-doc-counter" style={{ fontSize: 12, minWidth: 50, textAlign: "center" }}>
                      {currentIndex + 1} / {items.length}
                    </span>
                    <button
                      type="button"
                      className="tl-btn sm"
                      disabled={!hasNext}
                      onClick={goNext}
                      title="Next document (ArrowRight)"
                      aria-label="Next document">
                      <span>Next</span>
                      <Icon name="chevronRight" size={14} />
                    </button>
                    <span className="cp-kbd" style={{ marginLeft: 4 }}>← / →</span>
                  </div>
                ) : null}

                {/* Right: Actions */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginLeft: "auto" }}>
                  <div className="cp-doc-ctrls">
                    <button
                      type="button"
                      className="cp-doc-ctrl-btn"
                      onClick={() => setRotation((prev) => (prev + 90) % 360)}
                      title={`Rotate document 90° clockwise (${rotation}°)`}
                      aria-label="Rotate document">
                      <Icon name="rotate" size={13} />
                    </button>
                    <button
                      type="button"
                      className="cp-doc-ctrl-btn"
                      disabled={zoom <= 75}
                      onClick={() => setZoom((prev) => Math.max(75, prev - 25))}
                      title="Zoom out"
                      aria-label="Zoom out">
                      <Icon name="zoomOut" size={13} />
                    </button>
                    <button
                      type="button"
                      className="cp-doc-ctrl-btn"
                      onClick={() => { setZoom(100); setRotation(0); }}
                      title="Reset rotation & zoom"
                      style={{ fontSize: 10, width: "auto", padding: "0 4px", fontWeight: 700 }}>
                      {zoom}%
                    </button>
                    <button
                      type="button"
                      className="cp-doc-ctrl-btn"
                      disabled={zoom >= 200}
                      onClick={() => setZoom((prev) => Math.min(200, prev + 25))}
                      title="Zoom in"
                      aria-label="Zoom in">
                      <Icon name="zoomIn" size={13} />
                    </button>
                  </div>

                  <a
                    href={`/documents/${selectedDoc.id}?download=1`}
                    download={selectedDoc.name}
                    className="tl-btn sm"
                    style={{ fontSize: 12 }}>
                    Download ↓
                  </a>
                  <a
                    href={`/documents/${selectedDoc.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="tl-btn ghost sm"
                    style={{ fontSize: 12 }}>
                    Open in new tab ↗
                  </a>
                  <button
                    type="button"
                    onClick={() => setIsExpanded(false)}
                    className="tl-btn ghost sm"
                    style={{ fontSize: 12 }}
                    aria-label="Close expanded document view (Esc)">
                    ✕ Close (Esc)
                  </button>
                </div>
              </div>

              <div className="cp-doc-modal-body">
                <iframe
                  src={`/documents/${selectedDoc.id}`}
                  title={selectedDoc.name}
                  className="cp-doc-modal-frame"
                  style={{
                    transform: rotation !== 0 || zoom !== 100 ? `rotate(${rotation}deg) scale(${zoom / 100})` : undefined,
                    transformOrigin: "center center",
                    transition: "transform 150ms ease"
                  }}
                />
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

export function DriverCabSheet({
  driverView,
  driverName,
  equipmentType
}: {
  driverView: {
    origin: { address?: string; window_earliest?: string; window_latest?: string } | null;
    destination: { address?: string; window_earliest?: string; window_latest?: string } | null;
    stops: Array<{
      seq: number;
      type: "pickup" | "delivery";
      address?: string;
      window_earliest?: string;
      window_latest?: string;
      po_number?: string;
      dock_notes?: string;
    }>;
    equipment: { trailer_type?: string | null };
    driver_pay: { kind: string; rate: number; estimate?: number };
    reference: { broker_name?: string; load_number?: string };
    miles?: { loaded?: number };
  } | null;
  driverName: string | null;
  equipmentType: string | null;
}) {
  if (!driverView) return null;

  const payDesc = driverView.driver_pay
    ? `${driverView.driver_pay.kind === "per_mile" ? `${driverView.driver_pay.rate.toFixed(2)} / mi` : driverView.driver_pay.kind === "flat" ? `${driverView.driver_pay.rate.toFixed(2)} flat` : `${driverView.driver_pay.rate}%`}${driverView.driver_pay.estimate != null ? ` (Est. ${driverView.driver_pay.estimate.toFixed(2)})` : ""}`
    : "—";

  return (
    <div className="cp-cab-sheet">
      <div className="cp-cab-sheet-head">
        <div>
          <h4>Driver Cab Manifest (Mobile App Projection)</h4>
          <span style={{ fontSize: 11, color: "var(--db-fg-dim)" }}>
            Assigned to <strong>{driverName ?? "Unassigned"}</strong> · Equipment: {equipmentType ?? driverView.equipment.trailer_type ?? "Any Trailer"}
          </span>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "var(--db-fg-dim)", textTransform: "uppercase" }}>Driver Pay</div>
          <div style={{ fontWeight: 700, fontSize: 13, color: "var(--db-accent-fg)" }}>{payDesc}</div>
        </div>
      </div>

      <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
        {driverView.origin?.address ? (
          <div style={{ padding: "8px 10px", background: "var(--db-bg-card)", border: "1px solid var(--db-border)", borderRadius: "var(--db-r-md)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
              <strong style={{ color: "var(--db-pos)", textTransform: "uppercase", fontSize: 11 }}>Origin / Pickup</strong>
              <span style={{ color: "var(--db-fg-dim)", fontSize: 11 }}>
                {driverView.origin.window_earliest ? new Date(driverView.origin.window_earliest).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Window open"}
              </span>
            </div>
            <div>{driverView.origin.address}</div>
          </div>
        ) : null}

        {driverView.stops.map((st) => (
          <div key={st.seq} style={{ padding: "8px 10px", background: "var(--db-bg-card)", border: "1px solid var(--db-border)", borderRadius: "var(--db-r-md)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
              <strong style={{ color: "var(--db-accent-fg)", textTransform: "uppercase", fontSize: 11 }}>Stop {st.seq} ({st.type})</strong>
              <span style={{ color: "var(--db-fg-dim)", fontSize: 11 }}>
                {st.window_earliest ? new Date(st.window_earliest).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Window open"}
              </span>
            </div>
            <div>{st.address}</div>
            {st.po_number ? <div style={{ color: "var(--db-fg-dim)", marginTop: 2 }}>PO / Ref: {st.po_number}</div> : null}
            {st.dock_notes ? <div style={{ color: "var(--db-warn)", marginTop: 2 }}>Dock instructions: {st.dock_notes}</div> : null}
          </div>
        ))}

        {driverView.destination?.address ? (
          <div style={{ padding: "8px 10px", background: "var(--db-bg-card)", border: "1px solid var(--db-border)", borderRadius: "var(--db-r-md)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
              <strong style={{ color: "var(--db-accent-fg)", textTransform: "uppercase", fontSize: 11 }}>Destination / Delivery</strong>
              <span style={{ color: "var(--db-fg-dim)", fontSize: 11 }}>
                {driverView.destination.window_earliest ? new Date(driverView.destination.window_earliest).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Window open"}
              </span>
            </div>
            <div>{driverView.destination.address}</div>
          </div>
        ) : null}
      </div>

      <div style={{ padding: "6px 8px", background: "var(--db-bg-elev-2)", borderRadius: 4, fontSize: 11, color: "var(--db-fg-dim)", lineHeight: 1.4 }}>
        <strong>TrueLane Driver Firewall:</strong> Customer financials, rate confirmations, carrier margins, and total freight revenue are completely excluded from the driver terminal payload.
      </div>

      <details>
        <summary className="tl-sub" style={{ cursor: "pointer", fontSize: 11 }}>Show low-level JSON payload</summary>
        <pre style={{ margin: "6px 0 0", padding: 8, background: "var(--db-bg)", borderRadius: 6, overflowX: "auto", fontSize: 11, color: "var(--db-fg-mid)" }}>
          {JSON.stringify(driverView, null, 2)}
        </pre>
      </details>
    </div>
  );
}
