"use client";

import Link from "next/link";
import React from "react";
import { feet } from "@/lib/desk-format";
import { STATE_WORD, radarParamsText, type ListGroup, type ListRow, type RadarQueryParams, type SearchInfo } from "@/lib/radar-points";
import { countsText, milesText } from "@/lib/radius";
import type { RadarList as ListData } from "@/server/tl/radar-query";
import { useDraft } from "./kit/use-draft";

/**
 * Every unit in view as a list: nearest first when there is a search, sortable by name or state, optionally grouped by place (a shipper's dock with eight trailers reads as one line with eight in
 * it). A row opens the unit on the map; a stack clicked on the map arrives here as `ids`. Fifty rows (or twenty-five places) a page, fetched from the desk's own data route.
 */
const TONE: Record<string, string> = { moving_load: "label", idling: "warn", dwell: "warn", moving: "ink", dropped: "ink", hooked: "dim", parked: "dim", no_signal: "dim" };

function Row({ r, selected, onPick, showMiles }: { r: ListRow; selected: boolean; onPick: ListProps["onPick"]; showMiles: boolean }) {
  return (
    <tr className={selected ? "rd-row sel" : "rd-row"} aria-selected={selected} onClick={() => onPick(r.id, r.kind, r.lat, r.lng)}>
      <th scope="row">
        <button type="button" className="rd-rowbtn" onClick={() => onPick(r.id, r.kind, r.lat, r.lng)}>
          {r.name}
        </button>
        <span className="rd-sub">
          {r.kind === "trailer" ? `${r.code ?? "Trailer"}${r.lengthFt ? ` · ${feet(r.lengthFt)}` : ""}` : "Truck"}
        </span>
      </th>
      <td>
        <i className="rd-dot" data-tone={TONE[r.state] ?? "dim"} aria-hidden="true" /> {STATE_WORD[r.state]}
      </td>
      <td>{r.near ?? <span className="dim">{"—"}</span>}</td>
      {showMiles ? <td className="num">{r.miles != null ? milesText(r.miles) : "—"}</td> : null}
      <td>
        {r.loadId ? <Link href={`/loads/${r.loadId}`}>{r.loadNumber ?? "Load"}</Link> : (r.who ?? <span className="dim">{"—"}</span>)}
        {r.leak ? <span className="rd-leak rd-leak-row">{r.leak}</span> : null}
      </td>
      <td>
        <Link href={r.href}>Open</Link>
      </td>
    </tr>
  );
}

type ListProps = {
  params: RadarQueryParams;
  /** Units to list by id (a stack clicked on the map), replacing the search for now. */
  ids: string[] | null;
  onClearIds: () => void;
  selected: string | null;
  onPick: (id: string, kind: "tractor" | "trailer", lat: number, lng: number) => void;
  onParams: (next: Partial<RadarQueryParams>) => void;
  info: SearchInfo | null;
};

export function RadarList({ params, ids, onClearIds, selected, onPick, onParams, info }: ListProps) {
  const [page, setPage] = React.useState(1);
  // How the person likes the list (sorted, grouped by place) is kept, so coming back to it finds it as it was left.
  const [prefs, setPrefs] = useDraft<{ group: boolean; sort: RadarQueryParams["sort"] }>("radar:list", { group: false, sort: "distance" });
  const { group, sort } = prefs;
  const setGroup = (g: boolean) => setPrefs({ ...prefs, group: g });
  const setSort = (s: RadarQueryParams["sort"]) => setPrefs({ ...prefs, sort: s });
  const [data, setData] = React.useState<ListData | null>(null);
  const [busy, setBusy] = React.useState(false);
  const query = radarParamsText({ near: params.near, r: params.r, kind: params.kind, state: params.state, q: params.q, ids: ids ?? undefined, sort, page, group });
  React.useEffect(() => setPage(1), [params.near, params.r, params.kind, params.state, params.q, ids, group, sort]);
  React.useEffect(() => {
    let dead = false;
    setBusy(true);
    void fetch(`/fleet/map/data?mode=list${query ? `&${query}` : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!dead && j) setData(j as ListData);
      })
      .catch(() => undefined)
      .finally(() => !dead && setBusy(false));
    return () => {
      dead = true;
    };
  }, [query]);

  // A selection made on the map scrolls its row into view.
  const box = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (selected) box.current?.querySelector(".rd-row.sel")?.scrollIntoView({ block: "nearest" });
  }, [selected, data]);

  const withMiles = Boolean(info?.ok);
  const head = (
    <thead>
      <tr>
        <th scope="col">Unit</th>
        <th scope="col">State</th>
        <th scope="col">Near</th>
        {withMiles ? (
          <th scope="col" className="num">
            Away
          </th>
        ) : null}
        <th scope="col">Driver or load</th>
        <th scope="col" />
      </tr>
    </thead>
  );
  const groupBlock = (g: ListGroup) => (
    <tbody key={g.site} className="rd-group">
      <tr className="rd-group-head">
        <th colSpan={withMiles ? 6 : 5} scope="colgroup">
          <button type="button" className="rd-rowbtn" onClick={() => onPick(g.rows[0]!.id, g.rows[0]!.kind, g.lat, g.lng)}>
            {g.near ?? "At one place"}
          </button>
          <span className="rd-sub">{` · ${countsText(g.trucks, g.trailers)}`}</span>
        </th>
      </tr>
      {g.rows.map((r) => (
        <Row key={`${r.kind}-${r.id}`} r={r} selected={selected === r.id} onPick={onPick} showMiles={withMiles} />
      ))}
    </tbody>
  );

  return (
    <div className="rd-list" ref={box}>
      <div className="rd-listbar">
        <label className="tl-field">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as RadarQueryParams["sort"])}>
            <option value="distance">{info?.ok ? "Nearest first" : "Name"}</option>
            <option value="name">Name</option>
            <option value="state">State</option>
          </select>
        </label>
        <label className="rd-check">
          <input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} /> Group by place
        </label>
        {ids ? (
          <button type="button" className="tl-btn ghost sm" onClick={onClearIds}>
            {`Clear the ${ids.length} picked on the map`}
          </button>
        ) : null}
      </div>
      <p className="rd-sub" aria-live="polite">
        {busy && !data ? "Loading the list." : data ? `${data.total.toLocaleString("en-US")} ${group ? (data.total === 1 ? "place" : "places") : data.total === 1 ? "unit" : "units"}${ids ? " picked on the map" : info?.ok ? ` within ${info.radius} mi of ${info.label}` : ""}` : ""}
      </p>
      {data && data.total === 0 ? <p className="rd-sub">Nothing here. Widen the radius or clear a filter.</p> : null}
      {data && data.total > 0 ? (
        <table className="dt rd-table" aria-label="Units">
          {head}
          {data.groups ? (
            data.groups.map(groupBlock)
          ) : (
            <tbody>
              {data.rows.map((r) => (
                <Row key={`${r.kind}-${r.id}`} r={r} selected={selected === r.id} onPick={onPick} showMiles={withMiles} />
              ))}
            </tbody>
          )}
        </table>
      ) : null}
      {data && data.pages > 1 ? (
        <div className="rd-pager">
          <button type="button" className="tl-btn ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="rd-sub">{`Page ${data.page} of ${data.pages}`}</span>
          <button type="button" className="tl-btn ghost sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>
            More
          </button>
        </div>
      ) : null}
    </div>
  );
}
