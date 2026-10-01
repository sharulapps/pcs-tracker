import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker, { toFs, fromFs, sanitizeRecord } from '../worker/index.js';

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
    return reply({ candidates: [{ content: { parts: [{ text: '{"date":"2026-09-30","line":"Line B","hourly":[{"slot":"08:00-09:00","plan":90,"actual":88}],"confidence":0.9,"warnings":[]}' }] } }] });
  }
  const base = 'https://firestore.googleapis.com/v1/projects/demo-proj/databases/(default)/documents';
  assert.equal(init.headers.Authorization, 'Bearer tok');
  if (url === base + '/pcs_records' && init.method === 'POST') {
    const id = 'doc' + docs.size;
    const doc = { name: `${base}/pcs_records/${id}`, fields: JSON.parse(init.body).fields };
    docs.set(id, doc); return reply(doc);
  }
  if (url === base + ':runQuery') return reply([...docs.values()].map(document => ({ document })));
  if (init.method === 'DELETE') { docs.delete(url.split('/').pop()); return reply({}); }
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
  const r = sanitizeRecord({ date: '2026-09-30', line: 'L1', hourly: [{ slot: '8-9', plan: 10, actual: 8, reject: 1 }, { slot: '9-10', plan: 10, actual: '12' }] });
  assert.equal(r.dailyPlan, 20); assert.equal(r.totalActual, 20); assert.equal(r.totalReject, 1);
  assert.throws(() => sanitizeRecord({ date: '30/09/2026', hourly: [{}] }), /YYYY-MM-DD/);
});

test('health is open, other routes need the token', async () => {
  const h = await (await call('/api/health', { headers: { 'X-App-Token': '' } })).json();
  assert.equal(h.firestore, true); assert.equal(h.gemini, true);
  const r = await call('/api/records', { headers: { 'X-App-Token': 'nope' } });
  assert.equal(r.status, 401);
});

test('extract, save, list, delete', async () => {
  const ex = await (await call('/api/extract', { method: 'POST', body: JSON.stringify({ mimeType: 'image/jpeg', imageBase64: 'AAAA' }) })).json();
  assert.equal(ex.data.line, 'Line B');
  const saved = await call('/api/records', { method: 'POST', body: JSON.stringify({ ...ex.data, source: 'scan' }) });
  assert.equal(saved.status, 201);
  const { record } = await saved.json();
  assert.equal(record.totalActual, 88); assert.equal(record.hourly[0].plan, 90);
  const list = await (await call('/api/records?from=2026-09-01&to=2026-09-30')).json();
  assert.equal(list.records.length, 1); assert.equal(list.records[0].id, record.id);
  const del = await call('/api/records/' + record.id, { method: 'DELETE' });
  assert.equal(del.status, 200); assert.equal(docs.size, 0);
  assert.equal(calls.filter(u => u.includes('oauth2')).length, 1, 'token is cached');
});
