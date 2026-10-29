"use client";

import React from "react";
import { createPortal } from "react-dom";
import { Icon } from "./kit/icons";
import { addDays, addMonths, compareDays, display, formatValue, monthGrid, MONTHS, parseTyped, parseValue, type Hm, type Ymd } from "@/lib/date-field";

/**
 * The desk's date and date-and-time field, in place of the browser's own boxes (whose pop-up is grey and cannot be styled to match). It reads and writes the same
 * values a native box does ("2026-10-29", "2026-10-29T17:06"), calls `onChange` with an event-like `{ target: { value } }` so the handlers that were on a native box
 * still work, and carries a hidden input with the `name` so a plain form submit still sends it. In a <LiveForm> it also tells the form it changed.
 *
 * You can type a date ("10/29/2026", "10-29-26", "10/29/2026 5:06 pm") or open the calendar. The calendar is glass; arrow keys move by day and week,
 * Page Up and Page Down by month, Enter picks, Escape closes. A field that takes a time shows hour, minute and AM or PM under the month; picking a day keeps the time already
 * there, or starts at 8:00 AM. `min` and `max` are days ("2026-10-29") and grey out what is out of range.
 */
export type DateInputProps = {
  type?: "date" | "datetime-local";
  value?: string;
  defaultValue?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  name?: string;
  id?: string;
  disabled?: boolean;
  required?: boolean;
  min?: string;
  max?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
};

const START_TIME: Hm = { h: 8, min: 0 };
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const POP_W = 296;

function todayLocal(): Ymd {
  const n = new Date();
  return { y: n.getFullYear(), m: n.getMonth() + 1, d: n.getDate() };
}

export function DateInput({ type = "date", value, defaultValue, onChange, name, id, disabled, required, min, max, "aria-label": ariaLabel, "aria-invalid": invalid }: DateInputProps) {
  const withTime = type === "datetime-local";
  const controlled = value !== undefined;
  const [inner, setInner] = React.useState(defaultValue ?? "");
  const current = controlled ? value : inner;
  const parsed = parseValue(current);
  const shown = display(current, withTime);

  const [text, setText] = React.useState(shown);
  const [bad, setBad] = React.useState(false);
  const editing = React.useRef(false);
  // The box follows the value unless a person is in the middle of typing in it.
  React.useEffect(() => {
    if (!editing.current) {
      setText(shown);
      setBad(false);
    }
  }, [shown]);

  const hidden = React.useRef<HTMLInputElement>(null);
  const field = React.useRef<HTMLInputElement>(null);
  const pop = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const [place, setPlace] = React.useState<React.CSSProperties | null>(null);
  const [view, setView] = React.useState<{ y: number; m: number }>(() => ({ y: (parsed?.day ?? todayLocal()).y, m: (parsed?.day ?? todayLocal()).m }));
  const [focusDay, setFocusDay] = React.useState<Ymd>(() => parsed?.day ?? todayLocal());
  const minDay = parseValue(min)?.day ?? null;
  const maxDay = parseValue(max)?.day ?? null;
  const outOfRange = (d: Ymd) => (minDay != null && compareDays(d, minDay) < 0) || (maxDay != null && compareDays(d, maxDay) > 0);

  const commit = (next: string) => {
    if (!controlled) setInner(next);
    if (hidden.current) hidden.current.value = next;
    onChange?.({ target: { value: next, name: name ?? "" }, currentTarget: { value: next, name: name ?? "" } } as unknown as React.ChangeEvent<HTMLInputElement>);
    // A <LiveForm> reads its fields from the page, so tell it once the hidden input holds the new value.
    setTimeout(() => hidden.current?.dispatchEvent(new CustomEvent("desk-change", { bubbles: true })), 0);
  };

  const openCalendar = () => {
    if (disabled) return;
    const d = parsed?.day ?? todayLocal();
    setView({ y: d.y, m: d.m });
    setFocusDay(d);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) field.current?.focus();
  };

  // Where the pop-up goes: under the box, or above it when the window is short below; drawn on the page so a dialog or a card never clips it.
  React.useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = field.current?.parentElement?.getBoundingClientRect();
      if (!r) return;
      const height = pop.current?.offsetHeight ?? (withTime ? 400 : 340);
      const below = window.innerHeight - r.bottom - 8;
      const up = below < height && r.top - 8 > below;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - POP_W - 8));
      setPlace({ left, ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, withTime, view]);

  // Click outside closes; Escape closes this and nothing behind it (a dialog around the field stays open).
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || field.current?.parentElement?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mounted = place !== null;
  // Focus lands on the day you can act on when the calendar opens and as the arrow keys move it.
  React.useEffect(() => {
    if (!open) return;
    pop.current?.querySelector<HTMLButtonElement>('button[data-focus="true"]')?.focus();
  }, [open, focusDay, view, mounted]);

  const time = parsed?.time ?? START_TIME;
  const pick = (d: Ymd) => {
    if (outOfRange(d)) return;
    commit(formatValue(d, withTime ? time : null));
    if (withTime) moveFocus(d);
    else close(true);
  };
  const setTime = (next: Hm) => {
    const d = parsed?.day ?? (outOfRange(todayLocal()) ? (minDay ?? todayLocal()) : todayLocal());
    commit(formatValue(d, next));
  };
  const moveFocus = (d: Ymd) => {
    setFocusDay(d);
    setView({ y: d.y, m: d.m });
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const map: Record<string, Ymd> = {
      ArrowLeft: addDays(focusDay, -1),
      ArrowRight: addDays(focusDay, 1),
      ArrowUp: addDays(focusDay, -7),
      ArrowDown: addDays(focusDay, 7),
      PageUp: addMonths(focusDay, -1),
      PageDown: addMonths(focusDay, 1),
      Home: addDays(focusDay, -new Date(Date.UTC(focusDay.y, focusDay.m - 1, focusDay.d)).getUTCDay()),
      End: addDays(focusDay, 6 - new Date(Date.UTC(focusDay.y, focusDay.m - 1, focusDay.d)).getUTCDay())
    };
    const next = map[e.key];
    if (next) {
      e.preventDefault();
      moveFocus(next);
    }
  };

  const onTyped = () => {
    editing.current = false;
    const t = text.trim();
    if (t === "") {
      setBad(false);
      if (current !== "") commit("");
      return;
    }
    const v = parseTyped(t, withTime, parsed?.time ?? START_TIME);
    const d = v ? parseValue(v)?.day : null;
    if (!v || !d || outOfRange(d)) {
      setBad(true);
      return;
    }
    setBad(false);
    if (v !== current) commit(v);
    else setText(display(v, withTime));
  };

  const grid = monthGrid(view.y, view.m);
  const today = todayLocal();
  const h12 = time.h % 12 === 0 ? 12 : time.h % 12;
  const pm = time.h >= 12;
  const setHour12 = (n: number, isPm: boolean) => setTime({ h: (n % 12) + (isPm ? 12 : 0), min: time.min });

  return (
    <span className="dp-field">
      <input ref={hidden} type="hidden" name={name} value={current} disabled={disabled} />
      <input
        ref={field}
        id={id}
        type="text"
        className="dp-text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={withTime ? "mm/dd/yyyy, hh:mm AM" : "mm/dd/yyyy"}
        value={text}
        disabled={disabled}
        required={required}
        aria-label={ariaLabel}
        aria-invalid={invalid || bad ? true : undefined}
        onChange={(e) => {
          editing.current = true;
          setText(e.target.value);
        }}
        onBlur={onTyped}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onTyped();
          } else if (e.key === "ArrowDown" && e.altKey) {
            e.preventDefault();
            openCalendar();
          }
        }}
      />
      <button type="button" className="dp-open" onClick={() => (open ? close(false) : openCalendar())} disabled={disabled} aria-label="Open the calendar" aria-haspopup="dialog" aria-expanded={open}>
        <Icon name="calendar" />
      </button>
      {open && place
        ? createPortal(
            <div ref={pop} className="dp" role="dialog" aria-label={withTime ? "Choose a day and time" : "Choose a day"} style={{ ...place, width: POP_W }}>
              <div className="dp-head">
                <span className="dp-month" aria-live="polite">
                  {MONTHS[view.m - 1]} {view.y}
                </span>
                <button type="button" className="dp-nav prev" aria-label="Previous month" onClick={() => moveFocus(addMonths(focusDay, -1))}>
                  <Icon name="chevron" />
                </button>
                <button type="button" className="dp-nav next" aria-label="Next month" onClick={() => moveFocus(addMonths(focusDay, 1))}>
                  <Icon name="chevron" />
                </button>
              </div>
              <div className="dp-week" aria-hidden="true">
                {WEEKDAYS.map((w) => (
                  <span key={w}>{w}</span>
                ))}
              </div>
              <div className="dp-grid" role="grid" aria-label={`${MONTHS[view.m - 1]} ${view.y}`} onKeyDown={onGridKey}>
                {grid.map(({ day, inMonth }) => {
                  const selected = parsed != null && compareDays(parsed.day, day) === 0;
                  const isToday = compareDays(today, day) === 0;
                  const isFocus = compareDays(focusDay, day) === 0;
                  const off = outOfRange(day);
                  return (
                    <button
                      key={`${day.y}-${day.m}-${day.d}`}
                      type="button"
                      role="gridcell"
                      className={`dp-day${inMonth ? "" : " out"}${selected ? " sel" : ""}${isToday ? " today" : ""}`}
                      tabIndex={isFocus ? 0 : -1}
                      data-focus={isFocus ? "true" : undefined}
                      disabled={off}
                      aria-selected={selected}
                      aria-current={isToday ? "date" : undefined}
                      aria-label={`${MONTHS[day.m - 1]} ${day.d}, ${day.y}`}
                      onClick={() => pick(day)}>
                      {day.d}
                    </button>
                  );
                })}
              </div>
              {withTime ? (
                <div className="dp-time" role="group" aria-label="Time">
                  <input
                    className="dp-num"
                    inputMode="numeric"
                    aria-label="Hour"
                    value={String(h12)}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/\D/g, "").slice(-2));
                      if (n >= 1 && n <= 12) setHour12(n, pm);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                        e.preventDefault();
                        setHour12(((h12 - 1 + (e.key === "ArrowUp" ? 1 : -1) + 12) % 12) + 1, pm);
                      }
                    }}
                  />
                  <span aria-hidden="true">:</span>
                  <input
                    className="dp-num"
                    inputMode="numeric"
                    aria-label="Minute"
                    value={String(time.min).padStart(2, "0")}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/\D/g, "").slice(-2));
                      if (n >= 0 && n <= 59) setTime({ h: time.h, min: n });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                        e.preventDefault();
                        setTime({ h: time.h, min: (time.min + (e.key === "ArrowUp" ? 5 : -5) + 60) % 60 });
                      }
                    }}
                  />
                  <div className="cp-seg" role="group" aria-label="AM or PM">
                    <button type="button" aria-pressed={!pm} onClick={() => setHour12(h12, false)}>
                      AM
                    </button>
                    <button type="button" aria-pressed={pm} onClick={() => setHour12(h12, true)}>
                      PM
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="dp-foot">
                {required ? <span /> : (
                  <button
                    type="button"
                    className="dp-link"
                    onClick={() => {
                      commit("");
                      close(true);
                    }}>
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  className="dp-link"
                  onClick={() => {
                    if (!outOfRange(today)) pick(today);
                    else moveFocus(today);
                  }}>
                  Today
                </button>
                {withTime ? (
                  <button type="button" className="tl-btn primary sm" onClick={() => close(true)}>
                    Done
                  </button>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </span>
  );
}

