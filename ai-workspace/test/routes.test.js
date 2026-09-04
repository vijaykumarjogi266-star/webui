// Route-level integration tests: boots the real server on an ephemeral port and
// exercises every route's auth gate plus the CRUD lifecycles the smoke gate skips
// (SECURITY.md §7.5 — coverage was 11 of 30 routes).
//
//   node --test "test/*.test.js"
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.join(__dirname, '..');
const TOKEN = 'route-test-token-' + Math.random().toString(36).slice(2, 10);
const PORT = 3600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `127.0.0.1:${PORT}`;

let child;
let dataDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every route in server.js, with the auth class we expect.
const ALL_ROUTES = [
  ['GET', '/api/health/live', 'public'],
  ['GET', '/api/health/ready', 'public'],
  ['GET', '/api/auth/status', 'public'],
  ['POST', '/api/auth/login', 'public'],
  ['POST', '/api/auth/logout', 'protected'],
  ['GET', '/api/bootstrap', 'protected'],
  ['GET', '/api/credentials', 'protected'],
  ['POST', '/api/credentials', 'protected'],
  ['POST', '/api/credentials/abc/test', 'protected'],
  ['DELETE', '/api/credentials/abc', 'protected'],
  ['POST', '/api/credentials/abc/rotate', 'protected'],
  ['GET', '/api/models?cred=abc', 'protected'],
  ['POST', '/api/models/refresh', 'protected'],
  ['GET', '/api/conversations', 'protected'],
  ['POST', '/api/conversations', 'protected'],
  ['GET', '/api/conversations/abc', 'protected'],
  ['DELETE', '/api/conversations/abc', 'protected'],
  ['POST', '/api/chat/stream', 'protected'],
  ['GET', '/api/files', 'protected'],
  ['POST', '/api/files', 'protected'],
  ['DELETE', '/api/files/abc', 'protected'],
  ['GET', '/api/github', 'protected'],
  ['POST', '/api/github', 'protected'],
  ['DELETE', '/api/github/abc', 'protected'],
  ['GET', '/api/github/abc/file?path=x', 'protected'],
  ['GET', '/api/feedback', 'protected'],
  ['POST', '/api/feedback', 'protected'],
  ['PUT', '/api/feedback/abc', 'protected'],
  ['DELETE', '/api/feedback/abc', 'protected'],
  ['GET', '/api/usage', 'protected'],
];

function req(method, p, { body, auth = true, origin = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth) h.authorization = `Bearer ${TOKEN}`;
  if (origin && method !== 'GET') h.origin = `http://${ORIGIN}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  return fetch(BASE + p, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
}
const json = async (res) => { try { return await res.json(); } catch { return null; } };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-routes-'));
  child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(PORT), APP_TOKEN: TOKEN, NODE_ENV: 'test', AIW_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try { if ((await fetch(`${BASE}/api/health/live`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('server never became healthy');
});

after(async () => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await sleep(300);
  if (child && child.exitCode === null) child.kill('SIGKILL');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
test('every protected route rejects an unauthenticated request', async () => {
  const leaks = [];
  for (const [method, p, cls] of ALL_ROUTES) {
    if (cls !== 'protected') continue;
    const res = await req(method, p, { auth: false, body: method === 'GET' ? undefined : {} });
    if (res.status !== 401) leaks.push(`${method} ${p} -> ${res.status}`);
  }
  assert.deepEqual(leaks, [], 'these routes did not require auth');
});

test('every protected route rejects a bad bearer token', async () => {
  const leaks = [];
  for (const [method, p, cls] of ALL_ROUTES) {
    if (cls !== 'protected') continue;
    const res = await req(method, p, {
      auth: false, headers: { authorization: 'Bearer not-the-real-token' },
      body: method === 'GET' ? undefined : {},
    });
    if (res.status !== 401) leaks.push(`${method} ${p} -> ${res.status}`);
  }
  assert.deepEqual(leaks, [], 'these routes accepted a bad token');
});

test('every state-changing route enforces the CSRF origin check', async () => {
  const holes = [];
  for (const [method, p, cls] of ALL_ROUTES) {
    if (cls !== 'protected' || method === 'GET') continue;
    const res = await req(method, p, { origin: false, headers: { origin: 'https://evil.example' }, body: {} });
    if (res.status !== 403) holes.push(`${method} ${p} -> ${res.status}`);
  }
  assert.deepEqual(holes, [], 'these routes accepted a cross-origin request');
});

test('public routes are reachable without auth', async () => {
  for (const p of ['/api/health/live', '/api/health/ready', '/api/auth/status']) {
    const res = await req('GET', p, { auth: false });
    assert.equal(res.status, 200, `${p} must be public`);
  }
});

// ---------------------------------------------------------------------------
test('conversation lifecycle: create, read, list, delete', async () => {
  const created = await json(await req('POST', '/api/conversations', { body: {} }));
  const id = created.conversation.id;
  assert.match(id, /^[0-9a-f-]{36}$/);

  const got = await json(await req('GET', `/api/conversations/${id}`));
  assert.equal(got.conversation.id, id);
  assert.ok(Array.isArray(got.messages));

  const list = await json(await req('GET', '/api/conversations'));
  assert.ok(list.conversations.some((c) => c.id === id));

  assert.equal((await req('DELETE', `/api/conversations/${id}`)).status, 200);
  assert.equal((await req('GET', `/api/conversations/${id}`)).status, 404);
});

test('conversation routes validate ids', async () => {
  for (const bad of ['__proto__', '..', 'a%2fb']) {
    const res = await req('GET', `/api/conversations/${bad}`);
    assert.ok([400, 404].includes(res.status), `${bad} -> ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
test('file lifecycle: upload, index, list, delete cascades chunks', async () => {
  const text = 'Meridian Q3 revenue was 4.2 million dollars. Operating margin reached 18 percent.';
  const up = await json(await req('POST', '/api/files', {
    body: { name: 'report.txt', dataBase64: Buffer.from(text).toString('base64') },
  }));
  assert.equal(up.file.indexStatus, 'ready');
  assert.ok(up.file.chunks >= 1);
  const id = up.file.id;

  const list = await json(await req('GET', '/api/files'));
  assert.ok(list.files.some((f) => f.id === id));

  // Public shape must not leak internals.
  const f = list.files.find((x) => x.id === id);
  for (const k of ['enc', 'path', 'buffer']) assert.ok(!(k in f), `file exposes ${k}`);

  assert.equal((await req('DELETE', `/api/files/${id}`)).status, 200);
  const after = await json(await req('GET', '/api/files'));
  assert.ok(!after.files.some((x) => x.id === id));
});

test('file upload rejects unsupported types, bad base64 and fake PDFs', async () => {
  const bad = [
    { name: 'x.exe', dataBase64: Buffer.from('MZ').toString('base64') },
    { name: 'x.txt', dataBase64: 'not!valid!base64!' },
    { name: 'x.txt', dataBase64: '' },
    { name: '', dataBase64: Buffer.from('hi').toString('base64') },
  ];
  for (const body of bad) {
    const res = await req('POST', '/api/files', { body });
    assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 60)} -> ${res.status}`);
  }
  // A .pdf that isn't a PDF must not end up indexed.
  const fake = await json(await req('POST', '/api/files', {
    body: { name: 'fake.pdf', dataBase64: Buffer.from('<script>alert(1)</script>').toString('base64') },
  }));
  if (fake && fake.file) assert.notEqual(fake.file.indexStatus, 'ready');
});

test('file upload stores a path-stripped filename', async () => {
  const up = await json(await req('POST', '/api/files', {
    body: { name: '../../etc/passwd.txt', dataBase64: Buffer.from('data here').toString('base64') },
  }));
  assert.ok(!up.file.name.includes('/'), `filename kept a separator: ${up.file.name}`);
  assert.ok(!up.file.name.startsWith('.'), `filename kept a leading dot: ${up.file.name}`);
  await req('DELETE', `/api/files/${up.file.id}`);
});

// ---------------------------------------------------------------------------
test('feedback lifecycle: create, list, transition, delete', async () => {
  const created = await json(await req('POST', '/api/feedback', {
    body: { type: 'bug', title: 'Something broke', description: 'Details here', priority: 'high' },
  }));
  const id = created.feedback.id;
  assert.equal(created.feedback.status, 'new');

  const list = await json(await req('GET', '/api/feedback'));
  assert.ok(list.feedback.some((f) => f.id === id));

  const updated = await json(await req('PUT', `/api/feedback/${id}`, { body: { status: 'triaged' } }));
  assert.equal(updated.feedback.status, 'triaged');
  assert.ok(updated.feedback.history.length >= 2, 'status history must be appended');

  assert.equal((await req('PUT', `/api/feedback/${id}`, { body: { status: 'not-a-status' } })).status, 400);
  assert.equal((await req('PUT', '/api/feedback/does-not-exist', { body: { status: 'triaged' } })).status, 404);
  assert.equal((await req('DELETE', `/api/feedback/${id}`)).status, 200);
});

test('feedback rejects invalid enums and oversized text', async () => {
  const bad = [
    { type: 'nope', title: 't', description: 'd' },
    { type: 'bug', title: '', description: 'd' },
    { type: 'bug', title: 't', description: '' },
    { type: 'bug', title: 't', description: 'd', priority: 'ultra' },
    { type: 'bug', title: 'x'.repeat(300), description: 'd' },
    { type: 'bug', title: 't', description: 'x'.repeat(6000) },
  ];
  for (const body of bad) {
    assert.equal((await req('POST', '/api/feedback', { body })).status, 400, JSON.stringify(body).slice(0, 60));
  }
});

test('feedback withholds browser metadata without consent', async () => {
  const noConsent = await json(await req('POST', '/api/feedback', {
    body: { type: 'bug', title: 't', description: 'd', consent: false, browser: 'Firefox/1.0 secret' },
  }));
  assert.equal(noConsent.feedback.browser, null, 'browser metadata stored without consent');
  await req('DELETE', `/api/feedback/${noConsent.feedback.id}`);

  const consent = await json(await req('POST', '/api/feedback', {
    body: { type: 'bug', title: 't', description: 'd', consent: true, browser: 'Firefox/1.0' },
  }));
  assert.equal(consent.feedback.browser, 'Firefox/1.0');
  await req('DELETE', `/api/feedback/${consent.feedback.id}`);
});

// ---------------------------------------------------------------------------
test('credentials: validation, masking, and no plaintext key ever returned', async () => {
  const bad = [
    { provider: 'nope', apiKey: 'sk-1234567890' },
    { provider: 'openrouter', apiKey: 'short' },
    { provider: 'custom', apiKey: 'sk-1234567890' },                                  // missing baseUrl
    { provider: 'custom', apiKey: 'sk-1234567890', baseUrl: 'ftp://x/' },
    { provider: 'custom', apiKey: 'sk-1234567890', baseUrl: 'http://127.0.0.1/v1' },  // SSRF
    { provider: 'custom', apiKey: 'sk-1234567890', baseUrl: 'http://169.254.169.254/' },
    { provider: 'openrouter', apiKey: 'sk-abc\r\nX-Injected: 1' },                    // header injection
  ];
  for (const body of bad) {
    assert.equal((await req('POST', '/api/credentials', { body })).status, 400, JSON.stringify(body).slice(0, 70));
  }

  const secret = 'sk-or-v1-supersecretkeyvalue0123456789';
  const created = await json(await req('POST', '/api/credentials', {
    body: { provider: 'openrouter', apiKey: secret, displayName: 'Test key' },
  }));
  const id = created.credential.id;
  assert.ok(!JSON.stringify(created).includes(secret), 'create response leaked the raw key');
  assert.ok(created.credential.masked.includes('…'), 'key not masked');
  assert.equal(created.credential.status, 'not_tested');

  const listBody = await (await req('GET', '/api/credentials')).text();
  assert.ok(!listBody.includes(secret), 'list response leaked the raw key');
  assert.ok(!listBody.includes('"enc"'), 'list response exposed the ciphertext envelope');

  const bootBody = await (await req('GET', '/api/bootstrap')).text();
  assert.ok(!bootBody.includes(secret), 'bootstrap leaked the raw key');

  // Rotation validates too.
  assert.equal((await req('POST', `/api/credentials/${id}/rotate`, { body: { apiKey: 'x' } })).status, 400);
  const rotated = await json(await req('POST', `/api/credentials/${id}/rotate`, {
    body: { apiKey: 'sk-or-v1-rotatedkeyvalue987654321' },
  }));
  assert.equal(rotated.credential.status, 'not_tested');

  assert.equal((await req('DELETE', `/api/credentials/${id}`)).status, 200);
  assert.equal((await req('DELETE', `/api/credentials/${id}`)).status, 404);
});

test('models endpoint 404s for an unknown credential', async () => {
  assert.equal((await req('GET', '/api/models?cred=unknown-id')).status, 404);
  assert.equal((await req('POST', '/api/models/refresh', { body: { credentialId: 'unknown-id' } })).status, 404);
});

// ---------------------------------------------------------------------------
test('github connect rejects injected owner/repo without any network call', async () => {
  const bad = [
    { owner: '../../users', repo: 'x' },
    { owner: 'a/b', repo: 'x' },
    { owner: 'ok', repo: '../../../etc' },
    { owner: '', repo: 'x' },
    { owner: 'ok', repo: '' },
    { owner: '__proto__', repo: 'x' },
  ];
  for (const body of bad) {
    const res = await req('POST', '/api/github', { body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status}`);
  }
});

test('github file reader 404s for unknown repo/path', async () => {
  assert.equal((await req('GET', '/api/github/unknown-repo/file?path=README.md')).status, 404);
});

// ---------------------------------------------------------------------------
test('chat validates inputs before touching a provider', async () => {
  const bad = [
    [{}, 'empty body'],
    [{ credentialId: 'abc', model: 'm' }, 'missing message'],
    [{ credentialId: 'abc', model: 'm', message: '   ' }, 'blank message'],
    [{ credentialId: 'abc', model: 'm', message: 'hi', temperature: 9 }, 'temperature out of range'],
    [{ credentialId: 'abc', model: 'm', message: 'hi', temperature: -1 }, 'negative temperature'],
    [{ credentialId: 'abc', model: 'm', message: 'hi', fileIds: 'nope' }, 'fileIds not a list'],
    [{ credentialId: 'abc', model: 'm', message: 'hi', fileIds: ['../x'] }, 'bad file id'],
    [{ credentialId: 'abc', model: 'm', message: 'hi', conversationId: '__proto__' }, 'prototype key'],
    [{ credentialId: 'abc', model: 'm', message: 'hi', images: [{ dataUrl: 'http://169.254.169.254/' }] }, 'remote image'],
    [{ credentialId: 'abc', model: 'm', message: 'hi', images: [{ dataUrl: 'data:text/html;base64,PHN2Zz4=' }] }, 'non-image data url'],
    [{ credentialId: '../../x', model: 'm', message: 'hi' }, 'bad credential id'],
  ];
  for (const [body, why] of bad) {
    const res = await req('POST', '/api/chat/stream', { body });
    assert.equal(res.status, 400, `${why} -> ${res.status}`);
    const j = await json(res);
    assert.ok(j && j.error, `${why} did not return a JSON error`);
  }
});

// ---------------------------------------------------------------------------
test('usage endpoint returns a well-formed summary', async () => {
  const u = await json(await req('GET', '/api/usage'));
  assert.ok(u.totals && typeof u.totals.calls === 'number');
  assert.ok(Array.isArray(u.perConversation));
});

test('oversized JSON body is rejected with 413, not a crash', async () => {
  const res = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, origin: `http://${ORIGIN}` },
    body: JSON.stringify({ type: 'bug', title: 't', description: 'x'.repeat(13 * 1024 * 1024) }),
    signal: AbortSignal.timeout(20000),
  }).catch((e) => ({ status: 0, err: e.message }));
  assert.ok([400, 413].includes(res.status), `expected 413/400, got ${res.status}`);
  // Server must still be alive.
  assert.equal((await req('GET', '/api/health/live', { auth: false })).status, 200);
});

test('malformed JSON returns 400 and keeps the server alive', async () => {
  const res = await fetch(`${BASE}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, origin: `http://${ORIGIN}` },
    body: '{not json',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 400);
  assert.equal((await req('GET', '/api/health/live', { auth: false })).status, 200);
});

test('logout clears the session cookie', async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: `http://${ORIGIN}` },
    body: JSON.stringify({ token: TOKEN }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('aiw_session='));

  const authed = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie } });
  assert.equal(authed.status, 200, 'session cookie should authenticate');

  const out = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST', headers: { cookie, origin: `http://${ORIGIN}` },
  });
  assert.ok((out.headers.get('set-cookie') || '').includes('Max-Age=0'));
});

test('a forged session cookie is rejected', async () => {
  const forged = `aiw_session=${Date.now() + 9e6}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
  assert.equal((await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: forged } })).status, 401);
});
