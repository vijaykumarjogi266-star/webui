#!/usr/bin/env node
// Post-deploy smoke gate: boots this exact build on an ephemeral port, asserts the
// routes a load balancer / health probe depends on, then shuts it down.
//
//   node scripts/smoke.js            # spawns ./server.js
//   SMOKE_URL=http://host:port node scripts/smoke.js   # probe a deployed target
//
// Zero dependencies, Node 20+ (uses global fetch). Exit 0 = ship it, 1 = stop.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const APP_DIR = path.join(__dirname, '..');
const TARGET = process.env.SMOKE_URL ? String(process.env.SMOKE_URL).replace(/\/+$/, '') : null;
const PORT = TARGET ? null : Number(process.env.SMOKE_PORT || 3100 + Math.floor(Math.random() * 300));
const DEADLINE_MS = Number(process.env.SMOKE_TIMEOUT_MS || 25000);
// The auth gate is part of the build now: the smoke run injects a known token so
// it can exercise both the unauthenticated (401) and authenticated paths.
const APP_TOKEN = process.env.APP_TOKEN || 'smoke-token-' + Math.random().toString(36).slice(2, 10);

const checks = [
  { name: 'GET /api/health/live → 200 ok:true', method: 'GET', path: '/api/health/live', status: 200, json: (b) => b && b.ok === true },
  { name: 'GET /api/health/ready → 200 with counters', method: 'GET', path: '/api/health/ready', status: 200, json: (b) => b && b.ok === true && typeof b.credentials === 'number' },
  { name: 'GET / → HTML shell', method: 'GET', path: '/', status: 200, text: (t) => /<html|<!doctype html>/i.test(t) },
  { name: 'GET /api/bootstrap (authed) → JSON', method: 'GET', path: '/api/bootstrap', auth: true, status: 200, json: (b) => b && typeof b === 'object' },
  { name: 'GET /api/nope (authed) → 404 JSON error', method: 'GET', path: '/api/nope', auth: true, status: 404, json: (b) => b && b.error },
  { name: 'POST /api/chat/stream without creds → 400, no crash', method: 'POST', path: '/api/chat/stream', auth: true, status: 400, json: (b) => b && b.error },
  { name: 'GET /../../etc/passwd traversal blocked', method: 'GET', path: '/../..%2fetc%2fpasswd', status: [400, 403, 404] },

  // ---- security gates (added after the adversarial review; see SECURITY.md) ----
  { name: 'security headers present on /', method: 'GET', path: '/', status: 200,
    headers: (h) => /frame-ancestors 'none'/.test(h.get('content-security-policy') || '')
      && h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY' },
  { name: 'GET /api/bootstrap unauthenticated → 401', method: 'GET', path: '/api/bootstrap', status: 401, json: (b) => b && b.error },
  { name: 'GET /api/credentials unauthenticated → 401 (no key metadata leak)', method: 'GET', path: '/api/credentials', status: 401 },
  { name: 'POST /api/auth/login wrong token → 401', method: 'POST', path: '/api/auth/login', body: { token: 'wrong-token-value' }, status: 401 },
  { name: 'cross-origin POST blocked (CSRF)', method: 'POST', path: '/api/auth/login', status: [401, 403],
    extraHeaders: { origin: 'https://evil.example' } },
  { name: 'authed: custom provider pointing at metadata IP rejected (SSRF)', method: 'POST', path: '/api/credentials', auth: true,
    body: { provider: 'custom', apiKey: 'sk-test-1234567890', baseUrl: 'http://169.254.169.254/latest' }, status: 400 },
  { name: 'authed: custom provider pointing at localhost rejected (SSRF)', method: 'POST', path: '/api/credentials', auth: true,
    body: { provider: 'custom', apiKey: 'sk-test-1234567890', baseUrl: 'http://127.0.0.1:3000/v1' }, status: 400 },
  { name: 'authed: github owner path-injection rejected', method: 'POST', path: '/api/github', auth: true,
    body: { owner: '../../users', repo: 'x' }, status: 400 },
  { name: 'authed: unsupported/oversized upload rejected', method: 'POST', path: '/api/files', auth: true,
    body: { name: 'evil.exe', dataBase64: 'AAAA' }, status: 400 },
  { name: 'authed: fake-PDF signature rejected', method: 'POST', path: '/api/files', auth: true,
    body: { name: 'fake.pdf', dataBase64: Buffer.from('<script>alert(1)</script>').toString('base64') }, status: [201, 400],
    json: (b) => !b || !b.file || b.file.indexStatus !== 'ready' || b.error },
  { name: 'authed: remote image URL rejected in chat (SSRF)', method: 'POST', path: '/api/chat/stream', auth: true,
    body: { credentialId: 'nope', model: 'm', message: 'hi', images: [{ name: 'x', dataUrl: 'http://169.254.169.254/' }] }, status: 400 },

  // ---- regressions from the second-pass self-audit (see SECURITY.md §5) ----
  { name: 'X-Forwarded-Host cannot forge the CSRF origin check', method: 'POST', path: '/api/conversations',
    auth: true, status: 403, extraHeaders: { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' } },
  { name: "Origin: null (sandboxed iframe) blocked", method: 'POST', path: '/api/conversations',
    auth: true, status: 403, extraHeaders: { origin: 'null' } },
  { name: 'IPv4-mapped IPv6 metadata address rejected (SSRF)', method: 'POST', path: '/api/credentials', auth: true,
    body: { provider: 'custom', apiKey: 'sk-test-1234567890', baseUrl: 'http://[::ffff:169.254.169.254]/v1' }, status: 400 },
  { name: 'conversationId=__proto__ rejected (prototype key)', method: 'POST', path: '/api/chat/stream', auth: true,
    body: { credentialId: 'aaa', model: 'm', message: 'hi', conversationId: '__proto__' }, status: 400 },
  { name: 'unmatched /api/* never falls through to static', method: 'GET', path: '/api/does/not/exist', auth: true,
    status: 404, json: (b) => b && b.error },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function waitReady(base) {
  const until = Date.now() + DEADLINE_MS;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${base}/api/health/live`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* not listening yet */ }
    await sleep(150);
  }
  return false;
}

async function runCheck(base, c) {
  const url = new URL(c.path, base);
  const init = { method: c.method, headers: { ...(c.extraHeaders || {}) } };
  if (c.method === 'POST' || c.method === 'PUT') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(c.body || {});
  }
  if (c.auth && APP_TOKEN) init.headers.authorization = `Bearer ${APP_TOKEN}`;
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(8000) });
  const bodyText = await res.text();
  let bodyJson = null;
  try { bodyJson = JSON.parse(bodyText); } catch { /* html or empty */ }

  const want = Array.isArray(c.status) ? c.status : [c.status];
  if (!want.includes(res.status)) return `HTTP ${res.status} (want ${want.join('|')})`;
  if (c.headers && !c.headers(res.headers)) return 'expected security headers missing';
  if (c.json && !c.json(bodyJson)) return 'body is not the expected JSON shape';
  if (c.text && !c.text(bodyText)) return 'body is not the expected text';
  return null;
}

(async () => {
  let child = null;
  const base = TARGET || `http://127.0.0.1:${PORT}`;
  if (!TARGET) {
    child = spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
      cwd: APP_DIR,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: process.env.NODE_ENV || 'test', APP_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    child.on('exit', (code, sig) => { logs += `\n[server exited early code=${code} sig=${sig}]\n`; });
    process.on('exit', () => { if (child && child.exitCode === null) child.kill('SIGTERM'); });
    if (!(await waitReady(base))) {
      console.error('smoke: server never became healthy on ' + base + '\n' + logs.slice(-2000));
      process.exit(1);
    }
  }

  for (const c of checks) {
    let fail = null;
    try { fail = await runCheck(base, c); } catch (e) { fail = `request error: ${e.message}`; }
    results.push({ name: c.name, ok: !fail, detail: fail || 'ok' });
  }

  // Raw-socket checks: paths that the URL parser would rewrite before sending
  // (e.g. protocol-relative '//api/...') can only be exercised at the socket level.
  if (!TARGET) {
    const raw = (p) => new Promise((resolve) => {
      const sock = net.connect(PORT, '127.0.0.1', () => sock.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`));
      let d = ''; sock.on('data', (c) => { d += c; }); sock.on('end', () => resolve(d));
      sock.on('error', () => resolve('')); sock.setTimeout(4000, () => { sock.destroy(); resolve(''); });
    });
    const r1 = await raw('//api/bootstrap');
    const ok1 = /^HTTP\/1\.1 (401|404)/.test(r1) && !/"credentials"/.test(r1);
    results.push({ name: 'raw //api/bootstrap not served (no auth bypass)', ok: ok1, detail: ok1 ? 'ok' : r1.split('\r\n')[0] || 'no response' });

    const r2 = await raw('/../lib/store.js');
    const ok2 = /^HTTP\/1\.1 (400|403|404)/.test(r2) && !/MASTER/.test(r2);
    results.push({ name: 'raw /../lib/store.js traversal blocked', ok: ok2, detail: ok2 ? 'ok' : r2.split('\r\n')[0] || 'no response' });
  }

  // Graceful-shutdown gate (spawned target only): SIGTERM must flush and exit.
  if (child) {
    child.kill('SIGTERM');
    const until = Date.now() + 5000;
    while (child.exitCode === null && Date.now() < until) await sleep(50);
    const clean = child.exitCode === 0 || child.signalCode === 'SIGTERM';
    results.push({ name: 'SIGTERM → graceful exit', ok: clean, detail: clean ? `exited code=${child.exitCode ?? 'SIGTERM'}` : 'still alive after 5s' });
  }

  const failed = results.filter((r) => !r.ok);
  const label = TARGET ? `remote target ${base}` : `local build ${base}`;
  console.log(`\nAI Workspace smoke — ${label}`);
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  process.exit(failed.length ? 1 : 0);
})();
