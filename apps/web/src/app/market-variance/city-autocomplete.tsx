"use client";

import React from "react";
import { searchCities, type CitySuggestion } from "@/lib/us-cities";

interface Props {
  /** Current city text. */
  cityValue: string;
  /** Free typing (no suggestion picked yet). */
  onCityChange: (city: string) => void;
  /** A suggestion was chosen — fill both city AND state. */
  onPick: (city: string, state: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}

/**
 * Local city autocomplete backed by the bundled US-cities dataset (no Mapbox/Places
 * API). Prefix suggestions appear as you type; picking one fills the paired state too,
 * so a coordinator mid-negotiation types "phi" → picks "Philadelphia, PA" in one move.
 */
export function CityAutocomplete({ cityValue, onCityChange, onPick, placeholder, className, ariaLabel }: Props) {
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const suggestions = React.useMemo(() => searchCities(cityValue), [cityValue]);

  React.useEffect(() => {
    function onDocMouseDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  function pick(suggestion: CitySuggestion) {
    onPick(suggestion.city, suggestion.state);
    setOpen(false);
  }

  return (
    <div ref={wrapRef} className="db-city-ac">
      <input
        className={className}
        value={cityValue}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls="db-city-suggest"
        onChange={(event) => {
          onCityChange(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => {
          if (cityValue.trim().length >= 2) setOpen(true);
        }}
        onKeyDown={(event) => {
          if (!open || suggestions.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((a) => Math.min(a + 1, suggestions.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(suggestions[active]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && suggestions.length > 0 ? (
        <ul id="db-city-suggest" className="db-city-suggest" role="listbox">
          {suggestions.map((suggestion, i) => (
            <li
              key={suggestion.label}
              role="option"
              aria-selected={i === active}
              className={`db-city-suggest-item${i === active ? " active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {suggestion.label}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
