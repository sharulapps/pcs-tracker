# PCS Output Tracker

Records production output **plan vs actual** from photos of the paper PCS (Production Control Sheet).
Gemini reads the photo, the supervisor checks the numbers, and the record goes to Firestore and the dashboard.

Dashboard views:
- **Production output**: cumulative plan vs actual over the selected range, plus KPIs (achievement %, variance, days on target, reject rate, downtime)
- **Daily plan vs actual**: per day, with a table
- **Hourly plan vs actual**: per hour for any date/line, with cumulative plan, actual and %
- **By line**: summary per line

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
four weeks of sample records for 3 lines, stored in the browser. Scanning uses a simulated extraction.
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

Local dev: copy `.dev.vars.example` to `.dev.vars`, fill it in, run `npx wrangler dev`.

## Data model (`pcs_records`)

```json
{
  "date": "2026-10-01", "shift": "Day", "line": "Line B",
  "partNo": "HSG-1180", "partName": "Housing, pump", "supervisor": "Mei Ling",
  "dailyPlan": 706, "downtimeMin": 25,
  "hourly": [{ "slot": "08:00-09:00", "plan": 76, "actual": 71, "reject": 1, "remark": "" }],
  "totalActual": 655, "totalReject": 8, "source": "scan", "createdAt": "2026-10-01T09:12:00Z"
}
```

`dailyPlan` falls back to the sum of hourly plans when the form leaves it blank.
Change the model with `GEMINI_MODEL` in `wrangler.toml`.

## Tests

```bash
npm test   # Worker routes, Firestore encoding, service-account signing (Google endpoints mocked)
```
