/**
 * PCS Output Tracker — Cloudflare Worker
 *
 *   GET    /api/health            which backends are configured
 *   POST   /api/extract           { imageBase64, mimeType } -> Gemini -> structured PCS JSON
 *   GET    /api/records?from&to   list records (date range, YYYY-MM-DD)
 *   POST   /api/records           save a reviewed record to Firestore
 *   DELETE /api/records/:id       delete a record
 *
 * Everything else is served from ./public (static assets).
 *
 * Secrets (wrangler secret put ...):
 *   GEMINI_API_KEY          Google AI Studio key
 *   FIREBASE_PROJECT_ID     e.g. pcs-tracker-12345
 *   FIREBASE_CLIENT_EMAIL   service account email
 *   FIREBASE_PRIVATE_KEY    service account private key (PEM, \n escaped is fine)
 *   APP_TOKEN               optional shared token; clients send it as X-App-Token
 * Vars (wrangler.toml):
 *   GEMINI_MODEL            default "gemini-2.5-flash"
 *   ALLOWED_ORIGIN          CORS origin when the page is hosted elsewhere, default "*"
 */

const COLLECTION = 'pcs_records';
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
        return json(env, {
          ok: true,
          gemini: !!env.GEMINI_API_KEY,
          firestore: !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY),
          model: env.GEMINI_MODEL || 'gemini-2.5-flash',
        });
      }

      if (env.APP_TOKEN && request.headers.get('X-App-Token') !== env.APP_TOKEN) {
        return json(env, { error: 'Wrong or missing app token. Set it under Settings.' }, 401);
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
        return json(env, { record: await createRecord(env, rec) }, 201);
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
  const hourPlan = hourly.reduce((s, h) => s + h.plan, 0);
  return {
    date: r.date,
    shift: r.shift === 'Night' ? 'Night' : 'Day',
    line: str(r.line, 60) || 'Unassigned',
    partNo: str(r.partNo, 60),
    partName: str(r.partName, 120),
    supervisor: str(r.supervisor, 60),
    dailyPlan: num(r.dailyPlan) || hourPlan,
    downtimeMin: num(r.downtimeMin),
    hourly,
    totalActual: hourly.reduce((s, h) => s + h.actual, 0),
    totalReject: hourly.reduce((s, h) => s + h.reject, 0),
    source: r.source === 'scan' ? 'scan' : 'manual',
    createdAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Gemini extraction                                                    */
/* ------------------------------------------------------------------ */

const PCS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    date: { type: 'STRING', description: 'Production date as YYYY-MM-DD' },
    shift: { type: 'STRING', enum: ['Day', 'Night'] },
    line: { type: 'STRING', description: 'Production line / machine name as written' },
    partNo: { type: 'STRING' },
    partName: { type: 'STRING' },
    supervisor: { type: 'STRING' },
    dailyPlan: { type: 'INTEGER', description: 'Daily plan quantity in pcs; 0 if not written' },
    downtimeMin: { type: 'INTEGER', description: 'Total downtime minutes; 0 if not written' },
    hourly: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          slot: { type: 'STRING', description: 'Time slot as HH:MM-HH:MM (24h)' },
          plan: { type: 'INTEGER' },
          actual: { type: 'INTEGER' },
          reject: { type: 'INTEGER' },
          remark: { type: 'STRING' },
        },
        required: ['slot', 'plan', 'actual'],
      },
    },
    confidence: { type: 'NUMBER', description: '0 to 1, overall confidence in the reading' },
    warnings: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Cells that were unclear, crossed out or corrected' },
  },
  required: ['date', 'line', 'hourly', 'confidence', 'warnings'],
};

const PROMPT = `You are reading a photo of a factory Production Control Sheet (PCS).
Extract the header fields and every hourly row of the production table.

Rules:
- Return numbers as integers. Do not invent values: use 0 for an empty cell.
- Time slots in 24-hour "HH:MM-HH:MM" form, in the order they appear on the form.
- Dates on the form are usually DD/MM/YYYY (Malaysia). Output YYYY-MM-DD.
- If a cell is crossed out and rewritten, use the final value and add a warning naming the row.
- If the TOTAL row on the form does not match the sum of the hourly rows, add a warning.
- Ignore the TOTAL row itself; only return per-hour rows in "hourly".
- Remarks: short text as written (e.g. "Die change", "Material shortage").
- confidence: your honest overall confidence 0..1.`;

async function extractPcs(env, body) {
  if (!env.GEMINI_API_KEY) throw httpError('GEMINI_API_KEY is not set on the Worker', 503);
  const mimeType = str(body?.mimeType, 40) || 'image/jpeg';
  const imageBase64 = String(body?.imageBase64 || '');
  if (!/^image\//.test(mimeType)) throw httpError('Only images are accepted', 400);
  if (!imageBase64) throw httpError('imageBase64 is missing', 400);
  if (imageBase64.length * 0.75 > MAX_IMAGE_BYTES) throw httpError('Image is larger than 8 MB', 413);

  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: PCS_SCHEMA },
    }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError('Gemini error: ' + (out.error?.message || res.status), 502);
  const text = out.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  try {
    return JSON.parse(text);
  } catch {
    throw httpError('Gemini did not return readable data. Retake the photo with the whole form in frame.', 502);
  }
}

/* ------------------------------------------------------------------ */
/* Firestore (REST + service-account OAuth)                             */
/* ------------------------------------------------------------------ */

let cachedToken = null; // { token, exp }

async function googleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

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
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const out = await res.json();
  if (!res.ok) throw httpError('Google auth failed: ' + (out.error_description || out.error), 502);
  cachedToken = { token: out.access_token, exp: now + (out.expires_in || 3600) };
  return cachedToken.token;
}

async function firestore(env, path, init = {}) {
  if (!env.FIREBASE_PROJECT_ID) throw httpError('Firestore is not configured on the Worker', 503);
  const base = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const res = await fetch(base + path, {
    ...init,
    headers: { Authorization: `Bearer ${await googleAccessToken(env)}`, 'Content-Type': 'application/json' },
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError('Firestore error: ' + (out.error?.message || res.status), 502);
  return out;
}

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

async function createRecord(env, rec) {
  const doc = await firestore(env, `/${COLLECTION}`, {
    method: 'POST',
    body: JSON.stringify({ fields: toFs(rec).mapValue.fields }),
  });
  return docToRecord(doc);
}

async function listRecords(env, from, to) {
  // Range + orderBy on the same field needs no composite index.
  const rows = await firestore(env, ':runQuery', {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: COLLECTION }],
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
        limit: 5000,
      },
    }),
  });
  return rows.filter(r => r.document).map(r => docToRecord(r.document));
}
