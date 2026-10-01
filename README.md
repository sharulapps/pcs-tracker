# PCS Output Tracker

Records production output **plan vs actual**:

- **Plan** comes from the monthly Excel *PRODUCTION PLAN SUMMARY* (doc FR-PROD-001), imported in the **Monthly plan** tab.
- **Actual** comes from photos of the paper PCS (Production Control Sheet). Gemini reads the photo, the supervisor checks the numbers, and the record goes to Firestore and the dashboard.

## Monthly plan format

One sheet per revision (`SEPTEMBER REV 0`, `SEPTEMBER REV 1`, …). The highest visible `REV` sheet is picked by default; hidden sheets are ignored.

| Column | Meaning |
|---|---|
| MACHINE | P9, P10, P11, P12, T13, HP 2, WJ1, … (merged down the group) |
| MODEL | e.g. `SAGA MC3 HI` |
| OUTPUT / HOURS | plan rate in pcs/hour; the figure in brackets is ignored (`22 (20)` → 22) |
| OPERATOR | not imported; the operator is taken from the PCS form |
| one column per date | plan qty for that day |

Date cells: `D-120` = day shift 120 pcs, `N-200` = night shift 200 pcs, both lines in one cell = both shifts, a plain number = day shift.
The table ends at the `NO OF MOLD CHANGE DAILY` row; the INCOMING / BALANCE helper rows below it are ignored.

The hourly plan is the OUTPUT / HOURS rate laid out from the shift start (Day 08:00, Night 20:00 by default, changeable in Settings) until the day's plan qty is reached.

Note: the TOTAL column in the Excel uses `=SUM()`, which skips cells written as `D-xxx / N-xxx` (they are text). The app counts them, so its totals are higher than the Excel TOTAL for those rows.

## PCS form (FR-PROD-003)

The supervisor photographs the *DAILY PRODUCTION PERFORMANCE RECORD* at the end of each shift.

- Header: **Station** = machine + model (e.g. `P12 104D SILENCER FR PANEL`), **Date** `D.M.YYYY`, **Shift** DAY/NIGHT, Supervisor.
- Each table row: start/end hour in 12-hour labels (`8`/`9`, `12`/`1`, `2.3` = 2:30), Plan (this hour / cumulative), Actual (this hour / cumulative), downtime box + `TIME:` note.
- Footer: OK, NG, REWORK, Prepare / Check / Verify by.

Gemini only transcribes the form. The Worker (`normalizePcsForm`) then:
- converts hour labels to 24-hour times along the shift (night: `8`→20:00, `12`→00:00, `2.3`→02:30),
- checks each hourly figure against the cumulative column and uses the cumulative difference when they disagree, with a warning,
- warns when OK on the form differs from the hourly actuals,
- splits Station into machine and model so the record matches the monthly plan.

The hourly plan written on the form (with breaks and half hours) is used for the hourly chart; the monthly plan's output/hour is the fallback when a run has no PCS yet.


- **Daily output**: plan vs actual for the chosen date, and how many planned runs have a PCS scanned
- **Month to date**: everything accumulates from the 1st of the month up to the chosen date — plan to date, actual to date, achievement, balance to the month plan (with pcs/day needed over the remaining planned days), days on target, missing PCS, reject rate
- **Monthly output chart**: accumulated plan vs actual from the 1st
- **Daily plan vs actual**: per day, with accumulated plan / actual / % columns; click a day to select it
- **Hourly plan vs actual** for the chosen date
- **By machine and model**: month plan, plan to date, actual to date, balance, missing PCS
- Filters: machine, model, shift (D / N)

Stack: HTML + vanilla JS (`public/index.html`), Cloudflare Worker (`worker/index.js`), Firebase Firestore, Gemini API.

```
Phone camera ──► index.html ──► Worker /api/extract ──► Gemini (image → JSON)
                     │                                       │
                     │◄──────── review / correct ◄────────────┘
                     └──► Worker /api/records ──► Firestore (pcs_records)
                                                      │
                     Dashboard ◄──────────────────────┘
```

API keys stay on the Worker. The browser never talks to Gemini or Firestore directly.

## Demo mode

Open `public/index.html` straight in a browser, or any host without the Worker, and the app runs in **demo mode**:
the September 2026 plan (from `public/demo-data.js`, imported from the M1 REV 1 workbook) with simulated actuals, stored in the browser.
Scanning uses a simulated extraction.
Use **Scan PCS form → Use sample form** to see the full snap → extract → check → save flow.
Settings → *Reset demo data* restores the samples.

## Setup (live)

1. **Firebase**
   - Create a project at console.firebase.google.com and enable **Firestore** (Native mode).
   - Deploy `firestore.rules` (blocks all browser access; the Worker uses a service account).
   - Project settings → Service accounts → *Generate new private key*. Keep the JSON file private.
2. **Gemini**: create an API key at aistudio.google.com.
3. **Cloudflare Worker**
   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put FIREBASE_PROJECT_ID      # project_id from the JSON
   npx wrangler secret put FIREBASE_CLIENT_EMAIL    # client_email from the JSON
   npx wrangler secret put FIREBASE_PRIVATE_KEY     # private_key from the JSON
   npx wrangler secret put APP_TOKEN                # optional shared password
   npx wrangler deploy
   ```
   The Worker serves `public/` and `/api/*` on the same URL. Opening it switches the app to **Live · Firestore**.
   If you set `APP_TOKEN`, enter it once under Settings on each device.

### AI summary

The dashboard's **AI summary** panel (between the month-to-date cards and the monthly chart) sends the figures already on screen —
month to date, selected day, last 7 days, machines, best and worst models, missing PCS, top remarks — to `POST /api/summary`.
Gemini returns a headline, 3–5 findings tagged good / warn / crit / info, and up to 3 suggested actions, in Bahasa Melayu or English.
It runs only when someone presses the button, and the result is kept per filter selection so re-opening the page does not use quota.
In demo mode the app writes the summary itself from the same figures and says so.

### Gemini model and fallback

`GEMINI_MODEL` (default `gemini-3.6-flash`) reads the form. When Google answers "high demand" (503) the Worker waits and tries again,
then falls back to `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash-lite`; set it to an empty value to turn off).
The review panel shows which model read the form. When a model is retired, change `GEMINI_MODEL` in Cloudflare; no code change is needed.

### Several Gemini keys

Put several keys in `GEMINI_API_KEY` separated by commas, or add `GEMINI_API_KEY_2` … `GEMINI_API_KEY_5` (type Secret).
Keys are used in turn; when one hits a rate limit or its quota (429 / RESOURCE_EXHAUSTED) or Gemini is overloaded, the next key is tried.
Gemini quota is counted per Google Cloud project, so extra keys only add capacity when each comes from a different project.
`/api/health` shows how many keys are configured (`geminiKeys`), never the keys themselves.

Local dev: copy `.dev.vars.example` to `.dev.vars`, fill it in, run `npx wrangler dev`.

## Data model

Document ids are `date_shift_machine_model` slugs, so there is one plan entry and one PCS record per run. Re-saving a PCS replaces it, and re-importing a month replaces that month's plan.

`pcs_plans`
```json
{ "month": "2026-09", "date": "2026-09-30", "shift": "Day", "machine": "P11", "model": "SAGA MC3 HI",
  "ratePerHour": 22, "qty": 240 }
```

`pcs_records`
```json
{ "date": "2026-09-30", "shift": "Day", "machine": "P11", "model": "SAGA MC3 HI", "operator": "Ziarul",
  "supervisor": "Azman", "planQty": 240, "downtimeMin": 35,
  "hourly": [{ "slot": "08:00-09:00", "plan": 22, "actual": 19, "reject": 0, "remark": "" }],
  "totalActual": 220, "totalReject": 4, "source": "scan", "createdAt": "2026-09-30T12:10:00Z" }
```

`pcs_plan_meta`: one document per month (sheet, revision, file name, totals, import time).
Change the model with `GEMINI_MODEL` in `wrangler.toml`.

## Tests

```bash
npm test   # plan parser, Worker routes, Firestore encoding, service-account signing (Google endpoints mocked)
```
