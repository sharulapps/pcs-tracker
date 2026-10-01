/**
 * PCS Output Tracker — Cloudflare Worker
 *
 *   GET    /api/health            which backends are configured
 *   GET    /api/health?check=1    also signs in to Google and reads Firestore, and reports the error if one fails
 *   POST   /api/extract           { imageBase64, mimeType } -> Gemini -> structured PCS JSON
 *   GET    /api/records?from&to   list PCS records (date range, YYYY-MM-DD)
 *   POST   /api/records           save a reviewed PCS record (one per date/shift/machine/model; re-saving replaces it)
 *   DELETE /api/records/:id       delete a record
 *   GET    /api/plans?from&to     list plan entries from the monthly plan
 *   POST   /api/plans             { month, meta, entries } replace one month's plan
 *   GET    /api/plan-meta         list imported plan months
 *   POST   /api/summary           { stats, lang } -> Gemini summary of the dashboard figures
 *
 * Everything else is served from ./public (static assets).
 *
 * Secrets (wrangler secret put ...):
 *   GEMINI_API_KEY          Google AI Studio key; several keys may be given, separated by commas
 *   GEMINI_API_KEY_2 … _5   optional extra keys. On a rate limit or used-up quota the next key is tried.
 *                           Quota is per Google Cloud project, so extra keys only help when they come from other projects.
 *   FIREBASE_PROJECT_ID     e.g. pcs-tracker-12345
 *   FIREBASE_CLIENT_EMAIL   service account email
 *   FIREBASE_PRIVATE_KEY    service account private key (PEM, \n escaped is fine)
 *   APP_TOKEN               optional shared token; clients send it as X-App-Token
 * Vars (wrangler.toml):
 *   GEMINI_MODEL            default "gemini-3.6-flash"
 *   GEMINI_FALLBACK_MODEL   used when the main model is busy or over quota; default "gemini-3.5-flash-lite", "" to turn off
 *   ALLOWED_ORIGIN          CORS origin when the page is hosted elsewhere, default "*"
 */

const COLLECTION = 'pcs_records';
const PLANS = 'pcs_plans';
const PLAN_META = 'pcs_plan_meta';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    try {
      if (url.pathname === '/api/health') {
        const check = {};
        if (url.searchParams.has('check')) {
          try { await googleAccessToken(env); check.googleAuth = 'ok'; } catch (e) { check.googleAuth = e.message; }
          try { await firestore(env, `/${PLAN_META}?pageSize=1`); check.firestoreRead = 'ok'; } catch (e) { check.firestoreRead = e.message; }
        }
        const missing = ['GEMINI_API_KEY', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].filter(k => !env[k]);
        return json(env, {
          ...(Object.keys(check).length ? { check } : {}),
          ...(missing.length ? { missing } : {}),
          ok: true,
          gemini: geminiKeys(env).length > 0,
          geminiKeys: geminiKeys(env).length,
          firestore: !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY),
          model: geminiModels(env)[0],
          fallbackModels: geminiModels(env).slice(1),
        });
      }

      if (env.APP_TOKEN && request.headers.get('X-App-Token') !== env.APP_TOKEN) {
        return json(env, { error: 'Wrong or missing app token. Set it under Settings.' }, 401);
      }

      if (url.pathname === '/api/summary' && request.method === 'POST') {
        return json(env, { summary: await summarize(env, await request.json()) });
      }

      if (url.pathname === '/api/extract' && request.method === 'POST') {
        const body = await request.json();
        return json(env, { data: await extractPcs(env, body) });
      }

      if (url.pathname === '/api/records' && request.method === 'GET') {
        const from = url.searchParams.get('from') || '0000-01-01';
        const to = url.searchParams.get('to') || '9999-12-31';
        if (!isDate(from) || !isDate(to)) return json(env, { error: 'from/to must be YYYY-MM-DD' }, 400);
        return json(env, { records: await listRecords(env, from, to) });
      }

      if (url.pathname === '/api/records' && request.method === 'POST') {
        const rec = sanitizeRecord(await request.json());
        return json(env, await upsertRecord(env, rec), 201);
      }

      if (url.pathname === '/api/plans' && request.method === 'GET') {
        const from = url.searchParams.get('from') || '0000-01-01';
        const to = url.searchParams.get('to') || '9999-12-31';
        if (!isDate(from) || !isDate(to)) return json(env, { error: 'from/to must be YYYY-MM-DD' }, 400);
        return json(env, { plans: await queryRange(env, PLANS, from, to) });
      }

      if (url.pathname === '/api/plans' && request.method === 'POST') {
        const body = await request.json();
        return json(env, await replaceMonthPlan(env, body), 201);
      }

      if (url.pathname === '/api/plan-meta' && request.method === 'GET') {
        const out = await firestore(env, `/${PLAN_META}?pageSize=100`);
        const metas = (out.documents || []).map(docToRecord).sort((a, b) => b.month.localeCompare(a.month));
        return json(env, { metas });
      }

      const m = url.pathname.match(/^\/api\/records\/([A-Za-z0-9_-]{1,128})$/);
      if (m && request.method === 'DELETE') {
        await firestore(env, `/${COLLECTION}/${m[1]}`, { method: 'DELETE' });
        return json(env, { ok: true });
      }

      return json(env, { error: 'Not found' }, 404);
    } catch (err) {
      const status = err.status || 500;
      return json(env, { error: err.message || 'Server error' }, status);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-App-Token',
  };
}
function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env) },
  });
}
function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = v => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const str = (v, max = 120) => String(v ?? '').trim().slice(0, max);
/** Stable document id: one record / plan entry per date + shift + machine + model. */
export const slug = (...a) => a.join('_').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 140);

export function sanitizeRecord(r) {
  if (!r || typeof r !== 'object') throw httpError('Record body is missing', 400);
  if (!isDate(r.date)) throw httpError('date must be YYYY-MM-DD', 400);
  const hourly = (Array.isArray(r.hourly) ? r.hourly : []).slice(0, 24).map(h => ({
    slot: str(h.slot, 20),
    plan: num(h.plan),
    actual: num(h.actual),
    reject: num(h.reject),
    remark: str(h.remark, 200),
  }));
  if (!hourly.length) throw httpError('At least one hourly row is required', 400);
  const machine = str(r.machine, 60);
  const model = str(r.model, 120);
  if (!machine || !model) throw httpError('machine and model are required', 400);
  return {
    date: r.date,
    shift: r.shift === 'Night' ? 'Night' : 'Day',
    machine,
    model,
    operator: str(r.operator, 120),
    supervisor: str(r.supervisor, 60),
    planQty: num(r.planQty),
    downtimeMin: num(r.downtimeMin),
    okQty: num(r.okQty),
    ngQty: num(r.ngQty),
    reworkQty: num(r.reworkQty),
    hourly,
    totalActual: hourly.reduce((s, h) => s + h.actual, 0),
    totalReject: hourly.reduce((s, h) => s + h.reject, 0) || num(r.ngQty),
    source: r.source === 'scan' ? 'scan' : 'manual',
    createdAt: new Date().toISOString(),
  };
}

export function sanitizePlanEntry(e, month) {
  if (!e || !isDate(e.date) || !e.date.startsWith(month)) return null;
  const qty = num(e.qty);
  const machine = str(e.machine, 60), model = str(e.model, 120);
  if (!qty || !machine || !model) return null;
  return {
    month,
    date: e.date,
    shift: e.shift === 'Night' ? 'Night' : 'Day',
    machine,
    model,
    ratePerHour: Number(e.ratePerHour) > 0 ? Number(e.ratePerHour) : 0,
    qty,
  };
}

/* ------------------------------------------------------------------ */
/* Gemini extraction                                                    */
/* ------------------------------------------------------------------ */

// Form FR-PROD-003 "DAILY PRODUCTION PERFORMANCE RECORD" (Menang Nusantara).
// Gemini only transcribes what is written; normalizePcsForm() converts times and checks the numbers.
const PCS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    docNo: { type: 'STRING', description: 'DOC NO box, e.g. "FR-PROD-003"' },
    station: { type: 'STRING', description: 'Station line exactly as written, e.g. "P12 104D SILENCER FR PANEL"' },
    machine: { type: 'STRING', description: 'Machine part of Station, e.g. "P12", "HP 2", "WJ1", "T13"' },
    model: { type: 'STRING', description: 'Model part of Station, e.g. "104D SILENCER FR PANEL"' },
    dateText: { type: 'STRING', description: 'Date exactly as written, e.g. "30.9.2026"' },
    shift: { type: 'STRING', description: 'Shift as written, e.g. "NIGHT", "DAY", "N", "D"' },
    supervisor: { type: 'STRING' },
    rows: {
      type: 'ARRAY',
      description: 'One item per table row that has any number written in Plan or Actual, top to bottom. Skip empty rows.',
      items: {
        type: 'OBJECT',
        properties: {
          from: { type: 'STRING', description: 'Hour written top-left of the row, as written, e.g. "8", "12", "2.3"' },
          to: { type: 'STRING', description: 'Hour written bottom-left of the row, e.g. "9", "1", "3"' },
          plan: { type: 'INTEGER', description: 'Plan column, upper number (this hour). 0 if empty' },
          planCum: { type: 'INTEGER', description: 'Plan column, lower number (cumulative). 0 if empty' },
          actual: { type: 'INTEGER', description: 'Actual column, upper handwritten number (this hour). 0 if empty' },
          actualCum: { type: 'INTEGER', description: 'Actual column, lower handwritten number (cumulative). 0 if empty' },
          downtimeType: { type: 'STRING', description: 'Ticked or circled downtime box: MORNING, SS, MATERIAL, MACHINE, MAN or METHOD. Empty if none' },
          downtimeNote: { type: 'STRING', description: 'Text written after TIME: for this row, e.g. "START-8:30". Empty if none' },
        },
        required: ['from', 'to', 'plan', 'planCum', 'actual', 'actualCum'],
      },
    },
    ok: { type: 'INTEGER', description: 'OK quantity at the bottom right. 0 if empty' },
    ng: { type: 'INTEGER', description: 'NG quantity. 0 if empty' },
    rework: { type: 'INTEGER', description: 'REWORK quantity. 0 if empty' },
    preparedBy: { type: 'STRING', description: 'Name under PREPARE BY if readable, else empty' },
    checkedBy: { type: 'STRING' },
    verifiedBy: { type: 'STRING' },
    confidence: { type: 'NUMBER', description: '0 to 1, honest overall confidence in the reading' },
    warnings: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Cells that were unclear, crossed out or overwritten' },
  },
  required: ['station', 'dateText', 'shift', 'rows', 'confidence', 'warnings'],
};

const PROMPT = `You are reading a photo of a "DAILY PRODUCTION PERFORMANCE RECORD" form (doc FR-PROD-003, Menang Nusantara Sdn Bhd).
Transcribe what is written. Do not calculate or correct anything.

Header: Station (machine then model, e.g. "P12 104D SILENCER FR PANEL"), Date (D.M.YYYY), Supervisor, Shift (DAY or NIGHT).
Machines are names like P9, P10, P11, P12, T13, HP 2, WJ1, WJ2, HEAT ROLLER, VACUUM SUCTION, FOAMING, ASSEMBLY, LAMINATION.

Table, one row per hour:
- First column: start hour at the top-left of the diagonal, end hour at the bottom-right ("8" / "9"). "2.3" means 2:30.
- Plan column: upper number = plan output for this hour; lower number = cumulative plan counted from 8 o'clock (start of the shift).
- Actual column: handwritten upper number = actual output for this hour; lower number = cumulative actual counted from 8 o'clock.
  The lower number of a row is always the lower number of the row above plus this row's upper number.
- Ignore the Diff column.
- Downtime details on the right: which box is ticked/circled and any text after "TIME:".
Only return rows that have a number in Plan or Actual. Use 0 for an empty number.
Bottom right: OK, NG, REWORK quantities. Bottom left: PREPARE BY / CHECK BY / VERIFY BY names if readable.
If a number is overwritten or unclear, give your best reading and add a warning naming the row (e.g. "Row 2.3-3: actual could be 30 or 80").`;

/** "8" → {h:8,m:0}; "2.3" / "2.30" / "2:30" → {h:2,m:30} */
function parseClock(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,2})(?:[.:](\d{1,2}))?/);
  if (!m) return null;
  let min = m[2] ? Number(m[2]) : 0;
  if (m[2] && m[2].length === 1) min *= 10; // "2.3" = 2:30
  return { h: Number(m[1]) % 24, m: Math.min(59, min) };
}
const pad = n => String(n).padStart(2, '0');

/**
 * Convert the form's 12-hour labels to 24-hour times. Times only move forward from the
 * shift start (Day 08:00, Night 20:00), so "12" on a night shift is 00:00 and "1" is 01:00.
 */
export function to24h(label, shiftStartHour, prevOffset = 0) {
  const c = parseClock(label);
  if (!c) return null;
  const startMin = shiftStartHour * 60;
  const cands = [c.h % 12, (c.h % 12) + 12].map(h => {
    const mins = h * 60 + c.m;
    return { mins, off: (mins - startMin + 1440) % 1440 };
  }).sort((a, b) => a.off - b.off);
  const pick = cands.find(x => x.off >= prevOffset) || cands[cands.length - 1];
  return { text: `${pad(Math.floor(pick.mins / 60))}:${pad(pick.mins % 60)}`, off: pick.off };
}

/** Turn Gemini's transcription into the app's record draft, with cross-checks. */
export function normalizePcsForm(raw, { dayStart = 8, nightStart = 20 } = {}) {
  const warnings = (Array.isArray(raw?.warnings) ? raw.warnings : []).map(w => str(w, 300)).filter(Boolean);
  const n = v => Math.max(0, Math.round(Number(v) || 0));

  // Station -> machine + model
  const station = str(raw?.station, 160);
  let machine = str(raw?.machine, 60), model = str(raw?.model, 120);
  const sm = station.match(/^\s*(P\s*\d+|T\s*\d+|HP\s*\d+|WJ\s*\d+|HEAT ROLLER|VACUUM SUCTION|FOAMING|ASSEMBLY|PRE LAMINATION|LAMINATION)\s+(.+)$/i);
  if (sm) { machine = machine || sm[1].toUpperCase().replace(/^(P|T|WJ)\s+/, '$1'); model = model || sm[2].trim(); }
  if (!machine && station) { const [first, ...rest] = station.split(/\s+/); machine = first; model = model || rest.join(' '); }

  // Date "30.9.2026" (D.M.Y)
  let date = '';
  const dm = String(raw?.dateText || raw?.date || '').match(/(\d{1,4})[./-](\d{1,2})[./-](\d{2,4})/);
  if (dm) {
    let [d, mo, y] = dm[1].length === 4 ? [dm[3], dm[2], dm[1]] : [dm[1], dm[2], dm[3]];
    if (String(y).length === 2) y = '20' + y;
    date = `${y}-${pad(mo)}-${pad(d)}`;
  }
  if (!isDate(date)) { date = ''; warnings.push('Date could not be read. Please fill it in.'); }

  const shift = /^\s*(n|night|malam)/i.test(String(raw?.shift || '')) ? 'Night' : 'Day';
  const start = shift === 'Night' ? nightStart : dayStart;

  const rows = (Array.isArray(raw?.rows) ? raw.rows : [])
    .filter(r => n(r.plan) || n(r.planCum) || n(r.actual) || n(r.actualCum));
  const hourly = [];
  let prevOff = 0, prevPlanCum = 0, prevActCum = 0, cumOk = true;
  rows.forEach(r => {
    const a = to24h(r.from, start, prevOff);
    const b = a ? to24h(r.to, start, a.off) : null;
    if (a) prevOff = a.off;
    const label = `${str(r.from, 6)}-${str(r.to, 6)}`;
    const slot = a && b ? `${a.text}-${b.text}` : label;

    let plan = n(r.plan);
    const planCum = n(r.planCum);
    if (planCum && planCum >= prevPlanCum && planCum - prevPlanCum !== plan) {
      if (plan) warnings.push(`Row ${label}: plan ${plan} does not match cumulative ${planCum}; using ${planCum - prevPlanCum}.`);
      plan = planCum - prevPlanCum;
    }
    if (planCum) prevPlanCum = planCum;

    let actual = n(r.actual);
    const actCum = n(r.actualCum);
    if (actCum) {
      if (actCum < prevActCum) { cumOk = false; warnings.push(`Row ${label}: cumulative actual ${actCum} is lower than the row before. Please check.`); }
      else if (actCum - prevActCum !== actual) {
        warnings.push(`Row ${label}: actual reads ${actual} but cumulative ${actCum} gives ${actCum - prevActCum}; using ${actCum - prevActCum}. Please confirm.`);
        actual = actCum - prevActCum;
      }
      prevActCum = Math.max(prevActCum, actCum);
    } else prevActCum += actual;

    const remark = [str(r.downtimeType, 40), str(r.downtimeNote, 160)].filter(Boolean).join(': ');
    hourly.push({ slot, plan, actual, reject: 0, remark });
  });
  if (!hourly.length) warnings.push('No hourly rows were read. Retake the photo with the whole table in frame.');

  const sumActual = hourly.reduce((s, h) => s + h.actual, 0);
  const ok = n(raw?.ok), ng = n(raw?.ng), rework = n(raw?.rework);
  if (ok && ok !== sumActual) warnings.push(`OK total on the form is ${ok}, but the hourly actuals add up to ${sumActual}. Please confirm which is right.`);
  if (cumOk && prevActCum && prevActCum !== sumActual) warnings.push(`Last cumulative actual is ${prevActCum}, but the hourly actuals add up to ${sumActual}.`);

  return {
    docNo: str(raw?.docNo, 40), station, machine, model, date, shift,
    supervisor: str(raw?.supervisor, 60), operator: str(raw?.preparedBy, 120),
    checkedBy: str(raw?.checkedBy, 60), verifiedBy: str(raw?.verifiedBy, 60),
    okQty: ok, ngQty: ng, reworkQty: rework,
    hourly,
    confidence: Number.isFinite(Number(raw?.confidence)) ? Number(raw.confidence) : null,
    warnings: [...new Set(warnings)],
  };
}

/** All configured Gemini keys: GEMINI_API_KEY (comma separated allowed) plus GEMINI_API_KEY_2 … _5. */
export function geminiKeys(env) {
  const list = [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2, env.GEMINI_API_KEY_3, env.GEMINI_API_KEY_4, env.GEMINI_API_KEY_5]
    .flatMap(v => String(v ?? '').split(/[\s,]+/)).filter(Boolean);
  return [...new Set(list)];
}
let keyCursor = 0; // round-robin start, per Worker instance

/** Main model first, then fallbacks (GEMINI_FALLBACK_MODEL, comma separated; "" turns fallback off). */
export function geminiModels(env) {
  const fb = env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.5-flash-lite';
  return [...new Set([env.GEMINI_MODEL || 'gemini-3.6-flash', ...String(fb).split(/[\s,]+/)].filter(Boolean))];
}

/** "busy": Google overloaded (503 / UNAVAILABLE / high demand). "quota": rate limit or used-up quota on this key. */
export function geminiFailure(status, statusText, msg) {
  const t = `${statusText} ${msg}`;
  if (status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(t)) return 'busy';
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(t) || (status === 403 && /quota|rate/i.test(t))) return 'quota';
  if (status === 404) return 'missing';
  return 'error';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Call Gemini with JSON output. Tries each model in turn (main, then fallback); for each model every key.
 * If Google is busy it waits and goes round the keys once more before moving to the fallback model.
 * Returns { data, model }.
 */
async function callGemini(env, parts, schema, unreadable) {
  const keys = geminiKeys(env);
  if (!keys.length) throw httpError('GEMINI_API_KEY is not set on the Worker', 503);
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
  });
  const models = geminiModels(env);
  const pause = Number.isFinite(Number(env.GEMINI_RETRY_MS)) ? Number(env.GEMINI_RETRY_MS) : 1500;
  const start = keyCursor++ % keys.length;
  let out = null, used = '', lastErr = '';
  const seen = new Set();
  outer:
  for (const model of models) {
    for (let round = 0; round < 2; round++) {
      let busy = false;
      for (let i = 0; i < keys.length; i++) {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[(start + i) % keys.length] },
          body: payload,
        });
        const reply = await res.json().catch(() => ({}));
        if (res.ok) { out = reply; used = model; break outer; }
        lastErr = reply.error?.message || String(res.status);
        const kind = geminiFailure(res.status, reply.error?.status || '', lastErr);
        seen.add(kind);
        if (kind === 'missing') {
          if (models.length === 1) throw httpError(`Gemini model "${model}" was not found. Set GEMINI_MODEL in Cloudflare to a current model name. (${lastErr})`, 502);
          continue outer; // try the next model
        }
        if (kind === 'error') throw httpError('Gemini error: ' + lastErr, 502);
        if (kind === 'busy') busy = true;
      }
      if (!busy) break; // every key is over quota: no point waiting, go to the fallback model
      if (round === 0 && pause) await sleep(pause);
    }
  }
  if (!out) {
    if (seen.has('busy')) throw httpError(`Gemini is busy right now (high demand on Google's side). Wait a minute and try again. (${lastErr})`, 503);
    if (seen.has('missing') && !seen.has('quota')) throw httpError(`Gemini model "${models[0]}" was not found. Set GEMINI_MODEL in Cloudflare to a current model name. (${lastErr})`, 502);
    throw httpError(keys.length > 1
      ? `All ${keys.length} Gemini keys are at their limit. Wait a minute and try again. (${lastErr})`
      : `Gemini key is at its limit. Wait a minute and try again, or add another key. (${lastErr})`, 429);
  }
  const text = out.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  try {
    return { data: JSON.parse(text), model: used };
  } catch {
    throw httpError(unreadable, 502);
  }
}

async function extractPcs(env, body) {
  const mimeType = str(body?.mimeType, 40) || 'image/jpeg';
  const imageBase64 = String(body?.imageBase64 || '');
  if (!/^image\//.test(mimeType)) throw httpError('Only images are accepted', 400);
  if (!imageBase64) throw httpError('imageBase64 is missing', 400);
  if (imageBase64.length * 0.75 > MAX_IMAGE_BYTES) throw httpError('Image is larger than 8 MB', 413);
  const { data: raw, model } = await callGemini(env,
    [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageBase64 } }], PCS_SCHEMA,
    'Gemini did not return readable data. Retake the photo with the whole form in frame.');
  const hr = v => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 ? Number(v) : undefined);
  return { ...normalizePcsForm(raw, { dayStart: hr(body.dayStart) ?? 8, nightStart: hr(body.nightStart) ?? 20 }), aiModel: model };
}

/* ------------------------------------------------------------------ */
/* AI summary of the dashboard                                          */
/* ------------------------------------------------------------------ */

export const SUMMARY_CATEGORIES = ['Output', 'Machines', 'Selected day', 'Downtime', 'Quality', 'Data', 'Outlook'];
const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    headline: { type: 'STRING', description: 'One sentence: the single most important fact about output month to date, with the achievement %' },
    overview: { type: 'STRING', description: '2 to 4 sentences: where output stands, the trend, the main reason for any gap, and the outlook to month end' },
    points: {
      type: 'ARRAY',
      description: '6 to 12 detailed findings, each with figures, grouped by category, most important first within a category',
      items: {
        type: 'OBJECT',
        properties: {
          category: { type: 'STRING', enum: SUMMARY_CATEGORIES },
          tone: { type: 'STRING', enum: ['good', 'warn', 'crit', 'info'] },
          text: { type: 'STRING' },
        },
        required: ['category', 'tone', 'text'],
      },
    },
    actions: {
      type: 'ARRAY',
      description: '3 to 5 concrete next steps',
      items: {
        type: 'OBJECT',
        properties: {
          priority: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          text: { type: 'STRING' },
        },
        required: ['priority', 'text'],
      },
    },
  },
  required: ['headline', 'overview', 'points', 'actions'],
};

export function summaryPrompt(stats, lang) {
  const language = lang === 'en' ? 'English' : 'Bahasa Melayu (Malaysian factory style; technical terms such as plan, actual, output, downtime, PCS, reject, run rate may stay in English)';
  return `You are a senior production analyst at a Malaysian manufacturing plant (M1). Write a detailed briefing on plan vs actual output for the production manager, based only on the dashboard figures below.

Write in ${language}. Plain, direct sentences. No greetings, no filler.

What to cover (use each category when the data supports it):
- Output: month-to-date plan vs actual and achievement %, days on target, the 7-day trend versus the previous 7 days, best and worst day, Day vs Night shift.
- Machines: every machine below 95% with its gap in pcs, the biggest contributors to the total gap, the best performers; name the models behind each gap.
- Selected day: how the selected date went, run by run where useful; the worst hour of a weak run and its remark.
- Downtime: downtime minutes and categories (MATERIAL, MACHINE, MAN, METHOD, SS start/stop) and which machines they hit; repeated remarks.
- Quality: reject/NG pcs and rate, machines with the most rejects.
- Data: PCS forms not submitted (by machine), unplanned runs, anything that makes the figures incomplete.
- Outlook: projected month-end output at the current run rate versus the month plan, and the pcs/day needed on the remaining planned days.

Rules:
- Every point must contain specific figures (pcs, %, min, dates) taken from the data. Do not invent numbers, causes or names.
- When a remark or downtime note explains a gap, say so and quote it; otherwise do not guess a cause.
- Plan counts only up to the selected date; upcoming days are not behind.
- Name machines and models exactly as given.
- tone: good = on or above plan; warn = 90-99% or a data gap; crit = below 90% or a large loss; info = neutral fact.
- If there is no plan for the month, say the monthly plan has not been imported and focus on actual output and data.
- Write 6 to 12 points. Skip a category that has nothing to report rather than padding it.
- actions: 3 to 5, each naming the machine/model or form and what to do; priority high for the biggest loss or risk.

Dashboard figures (JSON):
${JSON.stringify(stats)}`;
}

async function summarize(env, body) {
  const stats = body?.stats;
  if (!stats || typeof stats !== 'object') throw httpError('stats is missing', 400);
  if (JSON.stringify(stats).length > 60000) throw httpError('Too much data to summarise. Narrow the filters.', 413);
  const { data, model } = await callGemini(env, [{ text: summaryPrompt(stats, body.lang) }], SUMMARY_SCHEMA,
    'Gemini did not return a readable summary. Try again.');
  const tones = ['good', 'warn', 'crit', 'info'], prios = ['high', 'medium', 'low'];
  return {
    headline: str(data.headline, 400),
    overview: str(data.overview, 1200),
    points: (Array.isArray(data.points) ? data.points : []).slice(0, 14).map(p => ({
      category: SUMMARY_CATEGORIES.includes(p?.category) ? p.category : 'Output',
      tone: tones.includes(p?.tone) ? p.tone : 'info',
      text: str(p?.text, 500),
    })).filter(p => p.text),
    actions: (Array.isArray(data.actions) ? data.actions : []).slice(0, 6).map(a => (typeof a === 'string'
      ? { priority: 'medium', text: str(a, 400) }
      : { priority: prios.includes(a?.priority) ? a.priority : 'medium', text: str(a?.text, 400) })).filter(a => a.text),
    aiModel: model,
    at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Firestore (REST + service-account OAuth)                             */
/* ------------------------------------------------------------------ */

let cachedToken = null; // { who, token, exp }

async function googleAccessToken(env) {
  const missing = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'].filter(k => !env[k]);
  if (missing.length) throw httpError(`Missing on the Worker: ${missing.join(', ')}. Add them in Cloudflare → Settings → Variables and Secrets as type Secret.`, 503);
  const now = Math.floor(Date.now() / 1000);
  const who = `${env.FIREBASE_CLIENT_EMAIL}|${env.FIREBASE_PRIVATE_KEY}`;
  if (cachedToken && cachedToken.who === who && cachedToken.exp - 60 > now) return cachedToken.token;

  const b64url = input =>
    btoa(typeof input === 'string' ? input : String.fromCharCode(...new Uint8Array(input)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  let key;
  try {
    const der = Uint8Array.from(atob(pem.replace(/^"|"$/g, '')), c => c.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    throw httpError('FIREBASE_PRIVATE_KEY is not a valid private key. Paste the whole private_key value from the service-account JSON, from -----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----.', 502);
  }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const out = await res.json();
  if (!res.ok) throw httpError('Google auth failed: ' + (out.error_description || out.error) + ' (check FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY come from the same JSON file)', 502);
  cachedToken = { who, token: out.access_token, exp: now + (out.expires_in || 3600) };
  return cachedToken.token;
}

async function firestore(env, path, init = {}, { allow404 = false } = {}) {
  if (!env.FIREBASE_PROJECT_ID) throw httpError('FIREBASE_PROJECT_ID is missing on the Worker. Add it in Cloudflare → Settings → Variables and Secrets as type Secret.', 503);
  const base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(base + path, {
    ...init,
    headers: { Authorization: `Bearer ${await googleAccessToken(env)}`, 'Content-Type': 'application/json' },
  });
  const out = await res.json().catch(() => ({}));
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw httpError('Firestore error: ' + (out.error?.message || res.status), 502);
  return out;
}
const docName = (env, coll, id) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${coll}/${id}`;

export function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFs(x)])) } };
}
export function fromFs(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}
const docToRecord = doc => ({ id: doc.name.split('/').pop(), ...fromFs({ mapValue: { fields: doc.fields || {} } }) });

async function upsertRecord(env, rec) {
  const id = slug(rec.date, rec.shift, rec.machine, rec.model);
  const existing = await firestore(env, `/${COLLECTION}/${id}`, {}, { allow404: true });
  const doc = await firestore(env, `/${COLLECTION}/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: toFs(rec).mapValue.fields }),
  });
  return { record: docToRecord(doc), replaced: !!existing };
}

async function batchWrite(env, writes) {
  for (let i = 0; i < writes.length; i += 400) {
    await firestore(env, ':batchWrite', { method: 'POST', body: JSON.stringify({ writes: writes.slice(i, i + 400) }) });
  }
}

async function replaceMonthPlan(env, body) {
  const month = String(body?.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw httpError('month must be YYYY-MM', 400);
  const entries = (Array.isArray(body.entries) ? body.entries : []).slice(0, 20000).map(e => sanitizePlanEntry(e, month)).filter(Boolean);
  if (!entries.length) throw httpError(`No plan entries for ${month}`, 400);
  const keep = new Map(entries.map(e => [slug(e.date, e.shift, e.machine, e.model), e]));

  // Remove last import's entries that are not in this revision.
  const old = await firestore(env, ':runQuery', {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: PLANS }],
        where: { fieldFilter: { field: { fieldPath: 'month' }, op: 'EQUAL', value: { stringValue: month } } },
        select: { fields: [{ fieldPath: '__name__' }] },
      },
    }),
  });
  const writes = old.filter(r => r.document).map(r => r.document.name.split('/').pop())
    .filter(id => !keep.has(id)).map(id => ({ delete: docName(env, PLANS, id) }));
  keep.forEach((e, id) => writes.push({ update: { name: docName(env, PLANS, id), fields: toFs(e).mapValue.fields } }));
  const m = body.meta || {};
  const meta = {
    month,
    sheet: str(m.sheet, 80), title: str(m.title, 160), revision: str(m.revision, 20), docNo: str(m.docNo, 40),
    issued: str(m.issued, 20), fileName: str(m.fileName, 200),
    entries: entries.length, total: entries.reduce((s, e) => s + e.qty, 0), importedAt: new Date().toISOString(),
  };
  writes.push({ update: { name: docName(env, PLAN_META, month), fields: toFs(meta).mapValue.fields } });
  await batchWrite(env, writes);
  return { saved: entries.length, removed: writes.filter(w => w.delete).length, meta };
}

async function listRecords(env, from, to) {
  return queryRange(env, COLLECTION, from, to);
}

async function queryRange(env, collectionId, from, to) {
  // Range + orderBy on the same field needs no composite index.
  const rows = await firestore(env, ':runQuery', {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          compositeFilter: {
            op: 'AND',
            filters: [
              { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: from } } },
              { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: to } } },
            ],
          },
        },
        orderBy: [{ field: { fieldPath: 'date' }, direction: 'ASCENDING' }],
        limit: 20000,
      },
    }),
  });
  return rows.filter(r => r.document).map(r => docToRecord(r.document));
}
