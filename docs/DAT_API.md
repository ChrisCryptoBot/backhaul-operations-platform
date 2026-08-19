# DAT market-rate integration

The Market Variance module pulls live lane rates from **DAT** when credentials are
configured, and falls back to a deterministic **mock** otherwise (the UI badges which
is active — "Live DAT" vs "Mock data"). Nothing breaks without DAT access; manual and
mock rates work meanwhile.

## What DAT access is required
- A **DAT iQ / RateView** entitlement that includes **API access** (rate lookups).
- Either of the following credential forms — the app auto-detects which you have:
  1. A **pre-minted API token** (used directly as the bearer), **or**
  2. A **service account**: username + password (+ the analytics **user email**),
     which the app exchanges via DAT's 2-step OAuth (organization token → user token).

## How to configure (Settings → DAT)
- Paste a **token** into "DAT API key", **or** fill "DAT username / password / user email".
- Leave a field blank to keep the stored value; secrets are encrypted at rest
  (AES-256-GCM) and never returned to the browser.
- On save, the Market Variance badge flips to **Live DAT** and lane lookups call DAT.

## Endpoints (override via env if DAT changes them)
- `DAT_TOKEN_URL` — org token (default `https://identity.api.dat.com/access/v1/token/organization`)
- `DAT_USER_TOKEN_URL` — user token (default `https://identity.api.dat.com/access/v1/token/user`)
- `DAT_RATEVIEW_URL` — rate lookup (default `https://analytics.api.dat.com/linehaulrates/v1/lookups`)
- `DAT_FORCE_MOCK=true` — force the mock regardless of stored credentials.

## Notes
- The live client is written to DAT's documented RateView shape but has not been
  verified against a live account; if a customer's contract differs, adjust the
  request/response mapping in `apps/web/src/server/dat/provider.ts` (it already parses
  responses defensively — array or object, nested `response.rate`). Any auth/transport
  failure falls back to the mock so a demo never breaks.
- Rates are cached per lane for 12h (`MarketRateQuote`), with a manual "refresh".
