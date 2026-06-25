"use client";

import React from "react";
import { diffNewUrgentKeys, type LoadAlertRollup } from "@/lib/ui/load-alerts";

const STORAGE_KEY = "db-alerts-enabled";

export type AlertNotifierPermission = NotificationPermission | "unsupported";

interface UseAlertNotifierOptions {
  /** Already-derived rollups for the current board (sorted), to avoid re-deriving. */
  rollups: LoadAlertRollup[];
  /** Re-fetch the board so alerts stay live even without a mutation. */
  refreshBoard: () => void | Promise<void>;
  /** Open a load's drawer when its notification is clicked. */
  onOpenLoad?: (loadId: string) => void;
}

interface AlertNotifierState {
  enabled: boolean;
  permission: AlertNotifierPermission;
  /** Toggle from a user gesture (required for permission + audio). */
  toggle: () => void | Promise<void>;
}

function playChime(ctx: AudioContext): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  osc.start();
  osc.stop(ctx.currentTime + 0.36);
}

/**
 * Desktop-notification + chime layer for the daily tracker. Watches the URGENT
 * alerts on the board and fires a single OS notification per *newly appearing*
 * urgent item (de-duped by `${loadId}:${kind}`), plus a chime. Keeps the board
 * live via a visibility-aware poll while enabled.
 */
export function useAlertNotifier({ rollups, refreshBoard, onOpenLoad }: UseAlertNotifierOptions): AlertNotifierState {
  const [enabled, setEnabled] = React.useState(false);
  const [permission, setPermission] = React.useState<AlertNotifierPermission>("default");
  const seenRef = React.useRef<Set<string>>(new Set());
  const seededRef = React.useRef(false);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const onOpenLoadRef = React.useRef(onOpenLoad);
  onOpenLoadRef.current = onOpenLoad;

  // Urgent alerts (with their load ref + label for the notification body).
  const urgentAlerts = React.useMemo(() => {
    const list: Array<{ key: string; loadId: string; ref: string; label: string }> = [];
    for (const rollup of rollups) {
      for (const alert of rollup.alerts) {
        if (alert.severity === "URGENT") {
          list.push({ key: alert.key, loadId: alert.sourceLoadId, ref: rollup.ref, label: alert.label });
        }
      }
    }
    return list;
  }, [rollups]);
  const urgentKeys = React.useMemo(() => urgentAlerts.map((a) => a.key), [urgentAlerts]);

  // Keep a ref of the current urgent count for the poll cadence (no effect restart).
  const hasUrgentRef = React.useRef(false);
  hasUrgentRef.current = urgentKeys.length > 0;

  // Initialise enabled/permission from capability + stored preference.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const supported = "Notification" in window;
    const perm: AlertNotifierPermission = supported ? Notification.permission : "unsupported";
    setPermission(perm);
    const stored = window.localStorage.getItem(STORAGE_KEY) === "true";
    setEnabled(stored && perm === "granted");
  }, []);

  const toggle = React.useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (enabled) {
      setEnabled(false);
      window.localStorage.setItem(STORAGE_KEY, "false");
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    setPermission(perm);
    const granted = perm === "granted";
    setEnabled(granted);
    window.localStorage.setItem(STORAGE_KEY, granted ? "true" : "false");
    // Create the AudioContext inside the gesture so the chime can play later.
    if (granted && !audioCtxRef.current) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) audioCtxRef.current = new Ctor();
    }
  }, [enabled]);

  // Fire notifications for newly-appearing urgent items.
  React.useEffect(() => {
    // Seed the seen-set on first observation (and whenever disabled) so we never
    // storm on page load or when the user just toggled on.
    if (!enabled || permission !== "granted") {
      seenRef.current = new Set(urgentKeys);
      seededRef.current = true;
      return;
    }
    if (!seededRef.current) {
      seenRef.current = new Set(urgentKeys);
      seededRef.current = true;
      return;
    }

    const fresh = diffNewUrgentKeys(seenRef.current, urgentKeys);
    if (fresh.length > 0) {
      const freshSet = new Set(fresh);
      for (const item of urgentAlerts) {
        if (!freshSet.has(item.key)) continue;
        try {
          const notification = new Notification(`Load ${item.ref} needs attention`, {
            body: item.label,
            tag: item.key
          });
          notification.onclick = () => {
            window.focus();
            onOpenLoadRef.current?.(item.loadId);
            notification.close();
          };
        } catch {
          // Notification construction can throw in some browsers; ignore.
        }
      }
      if (audioCtxRef.current) {
        try {
          void audioCtxRef.current.resume();
          playChime(audioCtxRef.current);
        } catch {
          // Audio is best-effort.
        }
      }
    }
    seenRef.current = new Set(urgentKeys);
  }, [enabled, permission, urgentKeys, urgentAlerts]);

  // Visibility-aware live poll so alerts stay current without a mutation.
  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;
    const schedule = () => {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const delay = hidden ? 30_000 : hasUrgentRef.current ? 5_000 : 15_000;
      timer = window.setTimeout(async () => {
        if (!active) return;
        try {
          await refreshBoard();
        } finally {
          if (active) schedule();
        }
      }, delay);
    };
    schedule();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled, refreshBoard]);

  return { enabled, permission, toggle };
}
