import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import worker, { toFs, fromFs, sanitizeRecord, sanitizePlanEntry, normalizePcsForm, to24h, geminiKeys, geminiModels, geminiFailure, verifyIdToken } from '../worker/index.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const idKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const jwk = { ...idKeys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = b => Buffer.from(b).toString('base64url');
function idToken(claims, { key = idKeys.privateKey, kid = 'k1' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: 'https://securetoken.google.com/demo-proj', aud: 'demo-proj', sub: 'uid-' + (claims.email || 'x'), iat: now, exp: now + 3600, auth_time: now, email_verified: true, ...claims };
  const head = b64u(JSON.stringify({ alg: 'RS256', kid })) + '.' + b64u(JSON.stringify(body));
  return head + '.' + createSign('RSA-SHA256').update(head).sign(key).toString('base64url');
}
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
const env = {
  GEMINI_API_KEY: 'g-key', FIREBASE_PROJECT_ID: 'demo-proj', FIREBASE_CLIENT_EMAIL: 'svc@demo.iam',
  FIREBASE_PRIVATE_KEY: pem, APP_TOKEN: 'secret', PLANTS: 'M1,M2',
};
const docs = new Map();
let lastExtractPrompt = '';
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push(url);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
  if (url === 'https://oauth2.googleapis.com/token') {
    assert.match(init.body, /assertion=[\w-]+\.[\w-]+\.[\w-]+$/);
    return reply({ access_token: 'tok', expires_in: 3600 });
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?')) {
    return init.headers['x-goog-api-key'] === 'hk'
      ? reply({ error: { status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } }, 400)
      : reply({ models: [] });
  }
  if (url.includes('generativelanguage')) {
    if (init.headers['x-goog-api-key'] === 'limited') return reply({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, 429);
    if (init.headers['x-goog-api-key'] === 'busy' || (init.headers['x-goog-api-key'] === 'busymain' && url.includes('gemini-3.6-flash')))
      return reply({ error: { status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } }, 503);
    if (init.headers['x-goog-api-key'] === 'bad') return reply({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid' } }, 400);
    const body = JSON.parse(init.body);
    if (body.contents[0].parts.length > 1) assert.equal(body.contents[0].parts[1].inline_data.data, 'AAAA');
    if (body.contents[0].parts.length > 1) lastExtractPrompt = body.contents[0].parts[0].text;
    if (body.contents[0].parts.length === 1) {
      assert.match(body.contents[0].parts[0].text, /Bahasa Melayu|English/);
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({ headline: 'Output 98.7% daripada plan.', overview: 'Ringkasan.',
        points: [{ category: 'Machines', tone: 'warn', text: 'P11 ketinggalan 554 pcs.' }, { category: 'Nope', tone: 'weird', text: 'x' }],
        actions: [{ priority: 'high', text: 'Semak P11.' }, 'Kumpul PCS.'] }) }] } }] });
    }
    const form = { station: 'P11 SAGA MC3 HI', dateText: '30.9.2026', shift: 'DAY', rows: [{ from: '8', to: '9', plan: 22, planCum: 22, actual: 20, actualCum: 20 }], confidence: 0.9, warnings: [] };
    return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(form) }] } }] });
  }
  if (url === 'https://cloudflare.com/cdn-cgi/trace') return new Response('fl=1\ncolo=SIN\nloc=MY\n');
  if (url === JWK_URL) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'max-age=3600' } });
  const base = 'https://firestore.googleapis.com/v1/projects/demo-proj/databases/(default)/documents';
  assert.equal(init.headers.Authorization, 'Bearer tok');
  if (!url.startsWith(base)) return reply({ error: { message: 'unexpected ' + url } }, 500);
  const rest = url.slice(base.length);
  const children = prefix => [...docs.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'));
  if (rest.endsWith(':runQuery')) {
    const parent = rest.slice(1, -':runQuery'.length);
    const q = JSON.parse(init.body).structuredQuery, coll = q.from[0].collectionId;
    const f = q.where.fieldFilter;
    return reply(children((parent ? parent + '/' : '') + coll + '/')
      .filter(([, d]) => !f || d.fields[f.field.fieldPath].stringValue === f.value.stringValue)
      .map(([, document]) => ({ document })));
  }
  if (rest === ':batchWrite') {
    for (const w of JSON.parse(init.body).writes) {
      if (w.delete) docs.delete(w.delete.split('/documents/')[1]);
      else docs.set(w.update.name.split('/documents/')[1], w.update);
    }
    return reply({});
  }
  const path = decodeURIComponent(rest.slice(1).split('?')[0]);
  if (init.method === 'PATCH') {
    const doc = { name: `projects/demo-proj/databases/(default)/documents/${path}`, fields: JSON.parse(init.body).fields };
    docs.set(path, doc); return reply(doc);
  }
  if (init.method === 'DELETE') { docs.delete(path); return reply({}); }
  if (path.split('/').length % 2 === 1) return reply({ documents: children(path + '/').map(([, d]) => d) });
  return docs.has(path) ? reply(docs.get(path)) : reply({ error: { message: 'not found' } }, 404);
  return reply({ error: { message: 'unexpected ' + url } }, 500);
};
const call = (path, init = {}) => worker.fetch(new Request('https://x.test' + path, {
  ...init, headers: { 'Content-Type': 'application/json', 'X-App-Token': 'secret', ...(init.headers || {}) },
}), env);

test('toFs/fromFs round trip', () => {
  const v = { a: 1, b: 1.5, c: 'x', d: [1, { e: true }], f: null };
  assert.deepEqual(fromFs(toFs(v)), v);
});

test('sanitizeRecord computes totals and rejects bad dates', () => {
  const r = sanitizeRecord({ date: '2026-09-30', machine: 'P11', model: 'SAGA MC3 HI', hourly: [{ slot: '8-9', plan: 10, actual: 8, reject: 1 }, { slot: '9-10', plan: 10, actual: '12' }] });
  assert.equal(r.totalActual, 20); assert.equal(r.totalReject, 1); assert.equal(r.shift, 'Day');
  assert.throws(() => sanitizeRecord({ date: '2026-09-30', machine: 'P11', hourly: [{}] }), /model/);
  assert.equal(sanitizePlanEntry({ date: '2026-10-01', machine: 'P9', model: 'X', qty: 5 }, '2026-09'), null);
  assert.throws(() => sanitizeRecord({ date: '30/09/2026', hourly: [{}] }), /YYYY-MM-DD/);
});

test('health is open, other routes need the token', async () => {
  const h = await (await call('/api/health', { headers: { 'X-App-Token': '' } })).json();
  assert.equal(h.firestore, true); assert.equal(h.gemini, true);
  const r = await call('/api/records', { headers: { 'X-App-Token': 'nope' } });
  assert.equal(r.status, 401);
});

test('extract, save (upsert), list, delete', async () => {
  const ex = await (await call('/api/extract', { method: 'POST', body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: 'AAAA' }) })).json();
  assert.equal(ex.data.machine, 'P11');
  const saved = await call('/api/records', { method: 'POST', body: JSON.stringify({ ...ex.data, plant: 'M1', source: 'scan' }) });
  assert.equal(saved.status, 201);
  const { record, replaced } = await saved.json();
  assert.equal(record.id, '2026-09-30-day-p11-saga-mc3-hi'); assert.equal(replaced, false);
  assert.equal(record.totalActual, 20); assert.equal(record.hourly[0].plan, 22);
  const again = await (await call('/api/records', { method: 'POST', body: JSON.stringify({ ...ex.data, plant: 'M1', hourly: [{ slot: '08:00-09:00', plan: 22, actual: 21 }] }) })).json();
  assert.equal(again.replaced, true); assert.equal(again.record.totalActual, 21);
  const list = await (await call('/api/records?plant=M1&from=2026-09-01&to=2026-09-30')).json();
  assert.equal(list.records.length, 1); assert.equal(list.records[0].id, record.id);
  assert.ok(docs.has('plants/M1/pcs_records/' + record.id));
  const other = await (await call('/api/records?plant=M2&from=2026-09-01&to=2026-09-30')).json();
  assert.equal(other.records.length, 0, 'plants are kept apart');
  const del = await call('/api/records/' + record.id + '?plant=M1', { method: 'DELETE' });
  assert.equal(del.status, 200); assert.ok(!docs.has('plants/M1/pcs_records/' + record.id));
  assert.equal(calls.filter(u => u.includes('oauth2')).length, 1, 'token is cached');
});

test('plan import replaces the month', async () => {
  const e = (date, shift, qty, model = 'SAGA MC3 HI') => ({ date, shift, machine: 'P11', model, ratePerHour: 22, qty });
  let r = await (await call('/api/plans', { method: 'POST', body: JSON.stringify({ plant: 'M1', month: '2026-09', meta: { sheet: 'SEPTEMBER REV 0', revision: '0' }, entries: [e('2026-09-01', 'Day', 120), e('2026-09-01', 'Night', 200), e('2026-09-02', 'Day', 50, 'OLD')] }) })).json();
  assert.equal(r.saved, 3);
  r = await (await call('/api/plans', { method: 'POST', body: JSON.stringify({ plant: 'M1', month: '2026-09', meta: { sheet: 'SEPTEMBER REV 1', revision: '1' }, entries: [e('2026-09-01', 'Day', 130), e('2026-09-01', 'Night', 200), e('2026-10-01', 'Day', 9)] }) })).json();
  assert.equal(r.saved, 2); assert.equal(r.removed, 1);
  const { plans } = await (await call('/api/plans?plant=M1&from=2026-09-01&to=2026-09-30')).json();
  assert.deepEqual(plans.map(p => [p.shift, p.qty]).sort(), [['Day', 130], ['Night', 200]]);
  const { metas } = await (await call('/api/plan-meta?plant=M1')).json();
  assert.equal(metas.length, 1); assert.equal(metas[0].revision, '1'); assert.equal(metas[0].total, 330);
});

test('health check=1 signs in and reads Firestore', async () => {
  const h = await (await call('/api/health?check=1', { headers: { 'X-App-Token': '' } })).json();
  assert.equal(h.check.googleAuth, 'ok'); assert.equal(h.check.firestoreRead, 'ok');
  const bad = await (await worker.fetch(new Request('https://x.test/api/health?check=1'), { ...env, FIREBASE_PRIVATE_KEY: 'not a key' })).json();
  assert.match(bad.check.googleAuth, /not a valid private key/);
});

test('health check names missing Firebase secrets', async () => {
  const h = await (await worker.fetch(new Request('https://x.test/api/health?check=1'), { GEMINI_API_KEY: 'k' })).json();
  assert.equal(h.firestore, false);
  assert.match(h.check.googleAuth, /Missing on the Worker: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY/);
});

// Transcription of the real FR-PROD-003 photo (P12, 30.9.2026, NIGHT), including the unclear "80" in row 2.3-3.
const FORM_P12 = {
  docNo: 'FR-PROD-003', station: 'P12 104D SILENCER FR PANEL', dateText: '30.9.2026', shift: 'NIGHT', supervisor: '',
  rows: [
    { from: '8', to: '9', plan: 30, planCum: 30, actual: 30, actualCum: 30, downtimeType: 'SS', downtimeNote: 'START-8:30' },
    { from: '9', to: '10', plan: 60, planCum: 90, actual: 60, actualCum: 90 },
    { from: '10', to: '11', plan: 60, planCum: 150, actual: 60, actualCum: 150 },
    { from: '11', to: '12', plan: 60, planCum: 210, actual: 60, actualCum: 210 },
    { from: '12', to: '1', plan: 60, planCum: 270, actual: 60, actualCum: 270 },
    { from: '2.3', to: '3', plan: 30, planCum: 300, actual: 80, actualCum: 300 },
    { from: '3', to: '4', plan: 60, planCum: 360, actual: 60, actualCum: 360 },
    { from: '4', to: '5', plan: 60, planCum: 420, actual: 60, actualCum: 420 },
    { from: '5', to: '6', plan: 60, planCum: 480, actual: 60, actualCum: 480 },
    { from: '6', to: '7', plan: 60, planCum: 540, actual: 60, actualCum: 540 },
    { from: '7', to: '8', plan: 60, planCum: 600, actual: 60, actualCum: 600, downtimeNote: 'STOP-8:00' },
    { from: '8', to: '9', plan: 0, planCum: 0, actual: 0, actualCum: 0 },
  ],
  ok: 660, ng: 0, rework: 0, preparedBy: 'Vaurz', confidence: 0.86, warnings: [],
};

test('to24h follows the shift clock', () => {
  assert.equal(to24h('8', 20).text, '20:00');
  assert.equal(to24h('12', 20, to24h('11', 20).off).text, '00:00');
  assert.equal(to24h('2.3', 20, to24h('12', 20, 240).off).text, '02:30');
  assert.equal(to24h('1', 8, to24h('12', 8).off).text, '13:00');
  assert.equal(to24h('8', 8).text, '08:00');
});

test('normalizePcsForm reads the real P12 night form', () => {
  const d = normalizePcsForm(FORM_P12);
  assert.equal(d.machine, 'P12'); assert.equal(d.model, '104D SILENCER FR PANEL');
  assert.equal(d.date, '2026-09-30'); assert.equal(d.shift, 'Night');
  assert.deepEqual(d.hourly.map(h => h.slot), ['20:00-21:00', '21:00-22:00', '22:00-23:00', '23:00-00:00', '00:00-01:00', '02:30-03:00',
    '03:00-04:00', '04:00-05:00', '05:00-06:00', '06:00-07:00', '07:00-08:00']);
  assert.equal(d.hourly[5].actual, 30, 'unclear 80 corrected from the cumulative 270 -> 300');
  assert.equal(d.hourly.reduce((s, h) => s + h.actual, 0), 600);
  assert.equal(d.hourly.reduce((s, h) => s + h.plan, 0), 600);
  assert.equal(d.hourly[0].remark, 'SS: START-8:30');
  assert.equal(d.okQty, 660); assert.equal(d.operator, 'Vaurz');
  assert.ok(d.warnings.some(w => /2\.3-3/.test(w)), 'warns about row 2.3-3');
  assert.ok(d.warnings.some(w => /OK total on the form is 660/.test(w)), 'warns OK 660 vs 600');
});

test('Gemini key rotation', async () => {
  assert.deepEqual(geminiKeys({ GEMINI_API_KEY: 'a, b', GEMINI_API_KEY_3: 'c', GEMINI_API_KEY_2: 'a' }), ['a', 'b', 'c']);
  const ask = e => worker.fetch(new Request('https://x.test/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: 'AAAA' }) }), { GEMINI_API_KEY: e });
  for (let i = 0; i < 3; i++) {
    const r = await ask('limited,g-key'); // whichever key starts, the limited one is skipped
    assert.equal(r.status, 200); assert.equal((await r.json()).data.machine, 'P11');
  }
  const all = await ask('limited');
  assert.equal(all.status, 429); assert.match((await all.json()).error, /at its limit/);
  const bad = await ask('bad,g-key');
  assert.ok([200, 502].includes(bad.status), 'a non-quota error is reported, not rotated past');
});

test('Gemini busy: retry, then fall back to Flash-Lite, then a clear message', async () => {
  assert.deepEqual(geminiModels({}), ['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(geminiModels({ GEMINI_FALLBACK_MODEL: '' }), ['gemini-3.6-flash']);
  assert.equal(geminiFailure(503, 'UNAVAILABLE', 'high demand'), 'busy');
  assert.equal(geminiFailure(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded'), 'quota');
  const ask = extra => worker.fetch(new Request('https://x.test/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: 'AAAA' }) }), { GEMINI_RETRY_MS: 0, ...extra });
  const fb = await ask({ GEMINI_API_KEY: 'busymain' });
  assert.equal(fb.status, 200);
  assert.equal((await fb.json()).data.aiModel, 'gemini-3.5-flash-lite');
  const busy = await ask({ GEMINI_API_KEY: 'busy' });
  assert.equal(busy.status, 503);
  assert.match((await busy.json()).error, /Gemini is busy right now/);
  const off = await ask({ GEMINI_API_KEY: 'busymain', GEMINI_FALLBACK_MODEL: '' });
  assert.equal(off.status, 503);
});

test('summary endpoint returns a cleaned summary', async () => {
  const r = await call('/api/summary', { method: 'POST', body: JSON.stringify({ lang: 'ms', stats: { month: '2026-09', planToDate: 85837, actualToDate: 84680 } }) });
  assert.equal(r.status, 200);
  const { summary } = await r.json();
  assert.equal(summary.headline, 'Output 98.7% daripada plan.');
  assert.equal(summary.overview, 'Ringkasan.');
  assert.deepEqual(summary.points.map(p => [p.category, p.tone]), [['Machines', 'warn'], ['Output', 'info']]);
  assert.deepEqual(summary.actions, [{ priority: 'high', text: 'Semak P11.' }, { priority: 'medium', text: 'Kumpul PCS.' }]);
  const bad = await call('/api/summary', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(bad.status, 400);
});

test('Google sign-in: token check, users, roles and plants', async () => {
  const live = { ...env, APP_TOKEN: undefined, FIREBASE_WEB_API_KEY: 'web-key', ADMIN_EMAILS: 'boss@x.my' };
  const as = (tok, path, init = {}) => worker.fetch(new Request('https://x.test' + path, { ...init,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } }), live);

  const cfg = await (await as(null, '/api/config')).json();
  assert.equal(cfg.auth.apiKey, 'web-key'); assert.equal(cfg.auth.authDomain, 'demo-proj.firebaseapp.com');
  assert.equal((await as(null, '/api/me')).status, 401);

  // bad tokens
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal((await as(idToken({ email: 'boss@x.my' }, { key: wrongKey }), '/api/me')).status, 401);
  assert.equal((await as(idToken({ email: 'boss@x.my', aud: 'other' }), '/api/me')).status, 401);
  assert.equal((await as(idToken({ email: 'boss@x.my', exp: 1 }), '/api/me')).status, 401);
  await assert.rejects(verifyIdToken(live, idToken({ email: 'boss@x.my', email_verified: false })), /verified/);

  // admin from ADMIN_EMAILS sees all plants and manages users/plants
  const boss = idToken({ email: 'Boss@X.my', name: 'Boss' });
  const me = await (await as(boss, '/api/me')).json();
  assert.equal(me.user.role, 'admin'); assert.deepEqual(me.plants.map(p => p.code), ['M1', 'M2']);
  const pl = await as(boss, '/api/plants', { method: 'PUT', body: JSON.stringify({ plants: [1, 2, 3, 4, 5].map(i => ({ code: 'm' + i, name: 'Plant ' + i })) }) });
  assert.deepEqual((await pl.json()).plants.map(p => p.code), ['M1', 'M2', 'M3', 'M4', 'M5']);

  // unknown Google account is refused until added
  const sup = idToken({ email: 'sup@x.my' });
  const denied = await as(sup, '/api/me');
  assert.equal(denied.status, 403); assert.match((await denied.json()).error, /not been given access/);
  assert.equal((await as(boss, '/api/users', { method: 'PUT', body: JSON.stringify({ email: 'SUP@x.my', role: 'supervisor', plants: ['M2', 'M9'] }) })).status, 200);
  const sme = await (await as(sup, '/api/me')).json();
  assert.equal(sme.user.role, 'supervisor'); assert.deepEqual(sme.plants.map(p => p.code), ['M2']);

  // supervisor: scan own plant only, no plan upload, no admin
  const rec = { plant: 'M2', date: '2026-10-01', shift: 'Day', machine: 'P9', model: 'X', hourly: [{ slot: '08:00-09:00', plan: 10, actual: 9 }] };
  const ok = await as(sup, '/api/records', { method: 'POST', body: JSON.stringify(rec) });
  assert.equal(ok.status, 201); assert.equal((await ok.json()).record.savedBy, 'sup@x.my');
  assert.equal((await as(sup, '/api/records', { method: 'POST', body: JSON.stringify({ ...rec, plant: 'M1' }) })).status, 403);
  assert.equal((await as(sup, '/api/records?plant=M1')).status, 403);
  assert.equal((await as(sup, '/api/plans', { method: 'POST', body: JSON.stringify({ plant: 'M2', month: '2026-10', entries: [] }) })).status, 403);
  assert.equal((await as(sup, '/api/users')).status, 403);
  assert.equal((await as(sup, '/api/records?plant=M7')).status, 400, 'unknown plant');

  // admin removes the user
  assert.equal((await as(boss, '/api/users/' + encodeURIComponent('sup@x.my'), { method: 'DELETE' })).status, 200);
  assert.equal((await as(sup, '/api/me')).status, 403);
});

test('migrate moves pre-plant data into a plant', async () => {
  docs.set('pcs_records/old-1', { name: 'projects/demo-proj/databases/(default)/documents/pcs_records/old-1', fields: toFs({ date: '2026-09-30' }).mapValue.fields });
  const r = await (await call('/api/admin/migrate', { method: 'POST', body: JSON.stringify({ plant: 'M1' }) })).json();
  assert.equal(r.moved.pcs_records, 1);
  assert.ok(docs.has('plants/M1/pcs_records/old-1')); assert.ok(!docs.has('pcs_records/old-1'));
});

test('location block: clear message and health check', async () => {
  assert.equal(geminiFailure(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.'), 'location');
  const h = await (await worker.fetch(new Request('https://x.test/api/health?check=1'), env)).json();
  assert.deepEqual(h.check.egress, { colo: 'SIN', loc: 'MY' }); assert.equal(h.check.gemini, 'ok');
  const hk = await (await worker.fetch(new Request('https://x.test/api/health?check=1'), { ...env, GEMINI_API_KEY: 'hk' })).json();
  assert.match(hk.check.gemini, /^Blocked by location/);
});

test('extract passes the plan model names to Gemini', async () => {
  const r = await call('/api/extract', { method: 'POST', body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: 'AAAA', knownModels: ['P9 | 3MOX OUTER', 'P11 | SAGA MC3 HI'] }) });
  assert.equal(r.status, 200);
  assert.match(lastExtractPrompt, /P9 \| 3MOX OUTER/); assert.match(lastExtractPrompt, /exactly as in this list/);
  await call('/api/extract', { method: 'POST', body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: 'AAAA' }) });
  assert.doesNotMatch(lastExtractPrompt, /this plant's production plan/);
});

test('STOP on the PCS form: marked hours and the empty hours after them', () => {
  const row = (from, to, plan, actual, extra = {}) => ({ from, to, plan, planCum: 0, actual, actualCum: 0, ...extra });
  const d = normalizePcsForm({
    station: 'P12 D88N/D63D', dateText: '5.10.2026', shift: 'DAY', confidence: 0.9, warnings: [],
    rows: [
      row('8', '9', 12, 12), row('9', '10', 12, 12),
      row('10', '11', 12, 5, { downtimeType: 'MACHINE', downtimeNote: 'STOP 10:20' }),
      row('11', '12', 12, 0), row('12', '1', 40, 0),
      row('1', '2', 12, 0, { stopped: true }),
      row('2', '3', 12, 9), row('3', '4', 12, 0),
    ],
  });
  assert.deepEqual(d.hourly.map(h => !!h.stop), [false, false, true, true, true, true, false, false]);
  assert.match(d.warnings.join(' '), /STOP marked on 4 hours .*: 71 pcs of plan/);
  // "START-8:30" is a start note, not a stop
  const s = normalizePcsForm({ station: 'P9 X', dateText: '5.10.2026', shift: 'DAY', confidence: 1, warnings: [], rows: [row('8', '9', 10, 4, { downtimeType: 'SS', downtimeNote: 'START-8:30' }), row('9', '10', 10, 0)] });
  assert.ok(s.hourly.every(h => !h.stop));
  // the flag survives saving; anything other than true is dropped
  const r = sanitizeRecord({ date: '2026-10-05', machine: 'P12', model: 'X', hourly: [{ slot: '8-9', plan: 12, actual: 0, stop: true }, { slot: '9-10', plan: 12, actual: 12, stop: 'yes' }] });
  assert.deepEqual(r.hourly.map(h => h.stop), [true, undefined]);
});
