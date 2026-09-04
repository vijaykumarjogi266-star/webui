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

const APP_DIR = path.join(__dirname, '..');
const TARGET = process.env.SMOKE_URL ? String(process.env.SMOKE_URL).replace(/\/+$/, '') : null;
const PORT = TARGET ? null : Number(process.env.SMOKE_PORT || 3100 + Math.floor(Math.random() * 300));
const DEADLINE_MS = Number(process.env.SMOKE_TIMEOUT_MS || 25000);

const checks = [
  { name: 'GET /api/health/live → 200 ok:true', method: 'GET', path: '/api/health/live', status: 200, json: (b) => b && b.ok === true },
  { name: 'GET /api/health/ready → 200 with counters', method: 'GET', path: '/api/health/ready', status: 200, json: (b) => b && b.ok === true && typeof b.credentials === 'number' },
  { name: 'GET / → HTML shell', method: 'GET', path: '/', status: 200, text: (t) => /<html|<!doctype html>/i.test(t) },
  { name: 'GET /api/bootstrap → JSON', method: 'GET', path: '/api/bootstrap', status: 200, json: (b) => b && typeof b === 'object' },
  { name: 'GET /api/nope → 404 JSON error', method: 'GET', path: '/api/nope', status: 404, json: (b) => b && b.error },
  { name: 'POST /api/chat/stream without creds → 400, no crash', method: 'POST', path: '/api/chat/stream', status: 400, json: (b) => b && b.error },
  { name: 'GET /../../etc/passwd traversal blocked', method: 'GET', path: '/../..%2fetc%2fpasswd', status: [400, 403, 404] },
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
  const init = { method: c.method, headers: {} };
  if (c.method === 'POST') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(c.body || {});
  }
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const bodyText = await res.text();
  let bodyJson = null;
  try { bodyJson = JSON.parse(bodyText); } catch { /* html or empty */ }

  const want = Array.isArray(c.status) ? c.status : [c.status];
  if (!want.includes(res.status)) return `HTTP ${res.status} (want ${want.join('|')})`;
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
      env: { ...process.env, PORT: String(PORT), NODE_ENV: process.env.NODE_ENV || 'test' },
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
