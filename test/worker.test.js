import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker, { toFs, fromFs, sanitizeRecord, sanitizePlanEntry } from '../worker/index.js';

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
    const body = JSON.parse(init.body);
    assert.equal(body.contents[0].parts[1].inline_data.data, 'AAAA');
    return reply({ candidates: [{ content: { parts: [{ text: '{"date":"2026-09-30","shift":"Day","machine":"P11","model":"SAGA MC3 HI","hourly":[{"slot":"08:00-09:00","plan":22,"actual":20}],"confidence":0.9,"warnings":[]}' }] } }] });
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
