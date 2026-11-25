// Checks how every module of the desk sits on the screen, against a running demo desk. Reads only: it opens pages, measures them and (if asked) takes pictures.
//
//   node scripts/check-layout.mjs                          every module at 1440, 1024, and the two widths where the big-screen zoom leaves the least room (1500 and 1700)
//   node scripts/check-layout.mjs --more                   the second screens (history, reports, imports, one load, one driver, ...)
//   node scripts/check-layout.mjs --only loads,drivers     some of them
//   node scripts/check-layout.mjs --widths 1440,1600,1800  other widths (1500 and up draw the big-screen zoom)
//   node scripts/check-layout.mjs --shots some/folder      a picture of each as well
//   node scripts/check-layout.mjs --ui cockpit --theme day the other look
//   node scripts/check-layout.mjs --role viewer            as another demo person
//
// What it holds a page to (docs/DESIGN_BRIEF.md, "The grid"): nothing scrolls sideways; what sits in the page starts on one left edge; a table row is 30px (one line) or 40px (the two-line kind, and a
// row that folded a fact onto its second line). It exits 1 when something breaks one of these, so it can be run after a change the way a test is.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = opt("base", "http://localhost:3100");
const ALL = ["quote", "loads", "dispatch", "messages", "planner", "alerts", "signals", "drivers", "schedules", "fleet/map", "fleet", "trailers", "customers", "lanes", "invoices", "settlements", "payroll", "fuel", "ifta", "leaks", "data-health", "kpi/moved", "kpi", "audit", "partners/issues", "settings"];
// The second screens: other views of a list, reports, imports, and one of each thing with a page of its own (found from its list: "list>selector").
const MORE = ["loads?view=history", "loads?view=deleted", "signals?status=resolved", "signals?status=sent", "payroll?show=all", "payroll/1099", "invoices/factoring", "kpi/quotes", "kpi/report", "signals/report", "data-health/report", "ifta/rates", "leaks/intake", "partners/showcase", "settings/rules", "settings?tab=integrations", "settings?tab=team", "drivers/import", "fleet/import", "trailers/import", "loads/import", "fuel/import", "customers/new",
  "loads>#loads-table a[href^='/loads/']", "drivers>a[href^='/drivers/']:not([href$=import])", "fleet>table a[href^='/fleet/']", "trailers>table a[href^='/trailers/']", "customers>table a[href^='/customers/']", "lanes>table a[href^='/lanes/detail']", "invoices>table a[href^='/invoices/']", "settlements>table a[href^='/settlements/']"];
const routes = opt("only", args.includes("--more") ? MORE.join(",") : ALL.join(",")).split(",").filter(Boolean);
const widths = opt("widths", "1440,1024,1500,1700").split(",").map(Number);
const shots = opt("shots", null);
const ui = opt("ui", "app");
const theme = opt("theme", "night");
const role = opt("role", "admin");
const quiet = args.includes("--quiet");
if (shots) fs.mkdirSync(shots, { recursive: true });

const ROWS = [30, 40];
/** Pixels a row may differ from the two heights (a 1px rule above or below it). */
const SLACK = 1;

function measure() {
  const main = document.querySelector(".t-main");
  if (!main) return { none: true };
  const edge = main.getBoundingClientRect().left;
  const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
  const px = (n) => Math.round(n / zoom);
  const name = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).join(".") : ""}`;
  const seen = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
  };
  const sideways = [];
  if (main.scrollWidth > main.clientWidth + 1) sideways.push(`page ${main.scrollWidth}/${main.clientWidth}`);
  for (const e of main.querySelectorAll("*")) {
    if (e.closest(".maplibregl-map") || !seen(e)) continue;
    const o = getComputedStyle(e).overflowX;
    if ((o === "auto" || o === "scroll" || o === "hidden") && e.scrollWidth > e.clientWidth + 1 && e.querySelector("table")) sideways.push(`${name(e)} ${e.scrollWidth}/${e.clientWidth}`);
  }
  // The pinned bars and edge-to-edge panes start at the main area's own edge on purpose; everything else starts 10px in.
  const lefts = {};
  const blocks = [...main.children].flatMap((c) => (getComputedStyle(c).display === "contents" || c.matches("fieldset") ? [...c.children] : [c]));
  for (const c of blocks) {
    if (!seen(c) || c.matches(".t-pagehead,.t-banner,.kbar,.tl-tabs,.eq-tabs,.skip")) continue;
    const l = px(c.getBoundingClientRect().left - edge) ;
    (lefts[l] ??= []).push(name(c));
  }
  const rows = {};
  for (const tr of main.querySelectorAll("table tbody tr")) {
    if (!seen(tr) || tr.matches(".dt-empty-row,.grp,[data-tall]") || tr.closest(".t-doc,.rp,.pl,.maplibregl-map,.dp")) continue;
    const h = px(tr.getBoundingClientRect().height);
    rows[h] = (rows[h] ?? 0) + 1;
  }
  return { sideways, lefts, rows, height: main.scrollHeight, fold: main.clientHeight };
}

const browser = await chromium.launch();
const problems = [];
const report = [];
for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const host = new URL(BASE).hostname;
  await context.addCookies([
    { name: "desk-demo", value: role, domain: host, path: "/" },
    { name: "desk-ui", value: ui, domain: host, path: "/" },
    { name: "desk-theme", value: theme, domain: host, path: "/" }
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
  for (const route of routes) {
    errors.length = 0;
    try {
      const [list, pick] = route.split(">");
      await page.goto(`${BASE}/${list}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      if (pick) {
        await page.waitForSelector(".t-main", { timeout: 30_000 });
        const to = await page.locator(pick).first().getAttribute("href", { timeout: 20_000 });
        await page.goto(`${BASE}${to}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      }
      await page.waitForSelector(".t-main", { timeout: 30_000 });
      await page.waitForTimeout(route.includes("map") ? 4000 : 1200);
      const m = await page.evaluate(measure);
      const here = `${route} @${width}`;
      for (const s of m.sideways ?? []) problems.push(`${here}: scrolls sideways, ${s}`);
      for (const [l, who] of Object.entries(m.lefts ?? {})) if (Number(l) !== 10) problems.push(`${here}: left edge ${l}, ${[...new Set(who)].join(" ")}`);
      for (const [h, n] of Object.entries(m.rows ?? {})) if (!ROWS.some((r) => Math.abs(Number(h) - r) <= SLACK)) problems.push(`${here}: ${n} row${n === 1 ? "" : "s"} ${h}px tall`);
      // Leaving a page cancels its prefetches, and taking a picture adds a style to the inputs: neither is the desk's.
      const real = errors.filter((e) => !/favicon|Failed to load resource|Failed to fetch RSC payload|Extra attributes from the server|webgl|GL Driver|tile/i.test(e));
      for (const e of [...new Set(real)]) problems.push(`${here}: console, ${e}`);
      report.push({ route, width, ...m, errors: real });
      if (shots) await page.screenshot({ path: path.join(shots, `${route.replace(/>.*/, "-one").replace(/[/?=&]/g, "-")}-${width}.png`) });
    } catch (e) {
      problems.push(`${route} @${width}: did not open, ${String(e).split("\n")[0]}`);
    }
  }
  await context.close();
}
await browser.close();
const out = opt("json", null);
if (out) fs.writeFileSync(out, JSON.stringify({ problems, report }, null, 1));
if (!quiet) for (const p of problems) console.log(p);
console.log(problems.length === 0 ? `Clean: ${report.length} pages.` : `${problems.length} problems on ${report.length} pages.`);
process.exitCode = problems.length === 0 ? 0 : 1;
