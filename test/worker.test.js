import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker, { toFs, fromFs, sanitizeRecord, sanitizePlanEntry, normalizePcsForm, to24h, geminiKeys } from '../worker/index.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
const env = {
  GEMINI_API_KEY: 'g-key', FIREBASE_PROJECT_ID: 'demo-proj', FIREBASE_CLIENT_EMAIL: 'svc@demo.iam',
  FIREBASE_PRIVATE_KEY: pem, APP_TOKEN: 'secret',
};
const docs = new Map();
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push(url);
  const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
  if (url === 'https://oauth2.googleapis.com/token') {
    assert.match(init.body, /assertion=[\w-]+\.[\w-]+\.[\w-]+$/);
    return reply({ access_token: 'tok', expires_in: 3600 });
  }
  if (url.includes('generativelanguage')) {
    if (init.headers['x-goog-api-key'] === 'limited') return reply({ error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, 429);
    if (init.headers['x-goog-api-key'] === 'bad') return reply({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid' } }, 400);
    const body = JSON.parse(init.body);
    assert.equal(body.contents[0].parts[1].inline_data.data, 'AAAA');
    const form = { station: 'P11 SAGA MC3 HI', dateText: '30.9.2026', shift: 'DAY', rows: [{ from: '8', to: '9', plan: 22, planCum: 22, actual: 20, actualCum: 20 }], confidence: 0.9, warnings: [] };
    return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify(form) }] } }] });
  }
  const base = 'https://firestore.googleapis.com/v1/projects/demo-proj/databases/(default)/documents';
  assert.equal(init.headers.Authorization, 'Bearer tok');
  const path = url.startsWith(base + '/') ? url.slice(base.length + 1).split('?')[0] : null;
  if (path && init.method === 'PATCH') {
    const doc = { name: `projects/demo-proj/databases/(default)/documents/${path}`, fields: JSON.parse(init.body).fields };
    docs.set(path, doc); return reply(doc);
  }
  if (path && init.method === 'DELETE') { docs.delete(path); return reply({}); }
  if (path && !path.includes('/')) return reply({ documents: [...docs.entries()].filter(([k]) => k.startsWith(path + '/')).map(([, d]) => d) });
  if (path) return docs.has(path) ? reply(docs.get(path)) : reply({ error: { message: 'not found' } }, 404);
  if (url === base + ':runQuery') {
    const q = JSON.parse(init.body).structuredQuery, coll = q.from[0].collectionId;
    const f = q.where.fieldFilter;
    return reply([...docs.entries()].filter(([k]) => k.startsWith(coll + '/'))
      .filter(([, d]) => !f || d.fields[f.field.fieldPath].stringValue === f.value.stringValue)
      .map(([, document]) => ({ document })));
  }
  if (url === base + ':batchWrite') {
    for (const w of JSON.parse(init.body).writes) {
      if (w.delete) docs.delete(w.delete.split('/documents/')[1]);
      else docs.set(w.update.name.split('/documents/')[1], w.update);
    }
    return reply({});
  }
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
  const saved = await call('/api/records', { method: 'POST', body: JSON.stringify({ ...ex.data, source: 'scan' }) });
  assert.equal(saved.status, 201);
  const { record, replaced } = await saved.json();
  assert.equal(record.id, '2026-09-30-day-p11-saga-mc3-hi'); assert.equal(replaced, false);
  assert.equal(record.totalActual, 20); assert.equal(record.hourly[0].plan, 22);
  const again = await (await call('/api/records', { method: 'POST', body: JSON.stringify({ ...ex.data, hourly: [{ slot: '08:00-09:00', plan: 22, actual: 21 }] }) })).json();
  assert.equal(again.replaced, true); assert.equal(again.record.totalActual, 21);
  const list = await (await call('/api/records?from=2026-09-01&to=2026-09-30')).json();
  assert.equal(list.records.length, 1); assert.equal(list.records[0].id, record.id);
  const del = await call('/api/records/' + record.id, { method: 'DELETE' });
  assert.equal(del.status, 200); assert.equal(docs.size, 0);
  assert.equal(calls.filter(u => u.includes('oauth2')).length, 1, 'token is cached');
});

test('plan import replaces the month', async () => {
  const e = (date, shift, qty, model = 'SAGA MC3 HI') => ({ date, shift, machine: 'P11', model, ratePerHour: 22, qty });
  let r = await (await call('/api/plans', { method: 'POST', body: JSON.stringify({ month: '2026-09', meta: { sheet: 'SEPTEMBER REV 0', revision: '0' }, entries: [e('2026-09-01', 'Day', 120), e('2026-09-01', 'Night', 200), e('2026-09-02', 'Day', 50, 'OLD')] }) })).json();
  assert.equal(r.saved, 3);
  r = await (await call('/api/plans', { method: 'POST', body: JSON.stringify({ month: '2026-09', meta: { sheet: 'SEPTEMBER REV 1', revision: '1' }, entries: [e('2026-09-01', 'Day', 130), e('2026-09-01', 'Night', 200), e('2026-10-01', 'Day', 9)] }) })).json();
  assert.equal(r.saved, 2); assert.equal(r.removed, 1);
  const { plans } = await (await call('/api/plans?from=2026-09-01&to=2026-09-30')).json();
  assert.deepEqual(plans.map(p => [p.shift, p.qty]).sort(), [['Day', 130], ['Night', 200]]);
  const { metas } = await (await call('/api/plan-meta')).json();
  assert.equal(metas.length, 1); assert.equal(metas[0].revision, '1'); assert.equal(metas[0].total, 330);
});

test('health check=1 signs in and reads Firestore', async () => {
  const h = await (await call('/api/health?check=1', { headers: { 'X-App-Token': '' } })).json();
  assert.deepEqual(h.check, { googleAuth: 'ok', firestoreRead: 'ok' });
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
