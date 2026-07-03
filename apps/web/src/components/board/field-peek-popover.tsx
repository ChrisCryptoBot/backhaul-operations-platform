"use client";

import React from "react";
import { CloseIcon } from "@/components/icons";
import {
  REFERENCE_NUMBER_KINDS,
  referenceNumberKindLabel,
  type ReferenceNumber
} from "@/lib/reference-numbers";
import { copyText } from "@/lib/ui/clipboard";

export interface FieldPeekPopoverProps {
  /** The clicked cell element the popover anchors to. */
  anchorEl: HTMLElement;
  /** Load ref for the header ("R123 · numbers"). */
  loadRef: string;
  /** Current reference numbers for the load. */
  values: ReferenceNumber[];
  /** Persist the edited list. Receives the shape the update-fields API accepts. */
  onSave: (fields: { referenceNumbers: ReferenceNumber[] }) => Promise<void>;
  onClose: () => void;
}

const POPOVER_WIDTH = 300;
const GAP = 6;
const MARGIN = 8;

/**
 * A small card anchored to a board cell that lists a load's reference numbers for
 * quick copy, with an inline edit mode. Aligned to the design system (uses the
 * existing tokens/classes); never opens the heavy drawer.
 */
export function FieldPeekPopover({ anchorEl, loadRef, values, onSave, onClose }: FieldPeekPopoverProps) {
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<ReferenceNumber[]>(values);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Position after first paint, flipping up / clamping so it stays on-screen and
  // clear of the sticky columns and the right copilot panel.
  React.useLayoutEffect(() => {
    const anchor = anchorEl.getBoundingClientRect();
    const height = cardRef.current?.offsetHeight ?? 240;
    let top = anchor.bottom + GAP;
    if (top + height > window.innerHeight - MARGIN) {
      top = Math.max(MARGIN, anchor.top - GAP - height);
    }
    let left = anchor.left;
    left = Math.min(left, window.innerWidth - POPOVER_WIDTH - MARGIN);
    left = Math.max(MARGIN, left);
    setPos({ left, top });
  }, [anchorEl, editing, draft.length]);

  // Dismiss on outside pointerdown, Escape, and scroll; return focus to the cell.
  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const onScroll = () => onClose();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      anchorEl.focus?.();
    };
  }, [anchorEl, onClose]);

  const flashCopied = React.useCallback(async (key: string, text: string) => {
    const ok = await copyText(text);
    if (!ok) return;
    setCopiedKey(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedKey(null), 1200);
  }, []);

  const copyAll = React.useCallback(() => {
    const text = values.map((v) => `${referenceNumberKindLabel(v.kind)}: ${v.value}`).join("\n");
    void flashCopied("__all__", text);
  }, [values, flashCopied]);

  const updateDraft = (index: number, patch: Partial<ReferenceNumber>) => {
    setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const removeRow = (index: number) => setDraft((rows) => rows.filter((_, i) => i !== index));
  const addRow = () => setDraft((rows) => [...rows, { kind: "PU", value: "", source: "MANUAL" }]);

  const startEdit = () => {
    setDraft(values.length > 0 ? values : [{ kind: "PU", value: "", source: "MANUAL" }]);
    setError(null);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setError(null);
  };
  const save = async () => {
    const cleaned = draft
      .map((r) => ({ ...r, value: r.value.trim() }))
      .filter((r) => r.value.length > 0);
    setSaving(true);
    setError(null);
    try {
      await onSave({ referenceNumbers: cleaned });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
      setSaving(false);
    }
  };

  return (
    <div
      ref={cardRef}
      className="db-peek"
      role="dialog"
      aria-label={`Reference numbers for ${loadRef}`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: POPOVER_WIDTH }}
    >
      <div className="db-peek-h">
        <span className="db-field-label">{loadRef} · numbers</span>
        <span className="db-peek-h-actions">
          {!editing ? (
            <button type="button" className="db-btn db-btn-mini db-btn-ghost" onClick={startEdit}>
              Edit
            </button>
          ) : null}
          <button type="button" className="db-peek-close" aria-label="Close" onClick={onClose}>
            <CloseIcon size={14} />
          </button>
        </span>
      </div>

      {!editing ? (
        values.length === 0 ? (
          <div className="db-peek-empty">
            No numbers on file.
            <button type="button" className="db-btn db-btn-mini" style={{ marginLeft: 8 }} onClick={startEdit}>
              Add
            </button>
          </div>
        ) : (
          <>
            <div className="db-peek-list">
              {values.map((v, i) => {
                const key = `${v.kind}-${v.value}-${i}`;
                return (
                  <div key={key} className="db-peek-row">
                    <span className="db-peek-kind">{referenceNumberKindLabel(v.kind)}</span>
                    <span className="db-peek-val mono">{v.value}</span>
                    <button type="button" className="db-btn db-btn-mini" onClick={() => void flashCopied(key, v.value)}>
                      {copiedKey === key ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                );
              })}
            </div>
            {values.length > 1 ? (
              <div className="db-peek-actions">
                <button type="button" className="db-btn db-btn-mini db-btn-ghost" onClick={copyAll}>
                  {copiedKey === "__all__" ? "Copied all ✓" : "Copy all"}
                </button>
              </div>
            ) : null}
          </>
        )
      ) : (
        <>
          <div className="db-peek-list">
            {draft.map((row, i) => (
              <div key={i} className="db-peek-row edit">
                <select
                  className="db-input db-peek-kind-select"
                  aria-label="Kind"
                  value={REFERENCE_NUMBER_KINDS.some((k) => k.value === row.kind) ? row.kind : "OTHER"}
                  onChange={(e) => updateDraft(i, { kind: e.target.value })}
                >
                  {REFERENCE_NUMBER_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <input
                  className="db-input"
                  aria-label="Number"
                  value={row.value}
                  placeholder="Number…"
                  onChange={(e) => updateDraft(i, { value: e.target.value })}
                />
                <button type="button" className="db-peek-remove" aria-label="Remove" onClick={() => removeRow(i)}>
                  <CloseIcon size={13} />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="db-btn db-btn-mini db-btn-ghost db-peek-add" onClick={addRow}>
            + Add number
          </button>
          {error ? <div className="db-peek-err">{error}</div> : null}
          <div className="db-peek-actions">
            <button type="button" className="db-btn db-btn-mini db-btn-ghost" disabled={saving} onClick={cancelEdit}>
              Cancel
            </button>
            <button type="button" className="db-btn db-btn-mini" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
