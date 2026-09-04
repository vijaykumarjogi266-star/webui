#!/usr/bin/env node
// Deployment preflight. Run against the environment you are about to deploy WITH:
//
//   APP_TOKEN=... TRUST_PROXY=true npm run preflight
//
// Checks the configuration mistakes that do not surface until users are already
// affected: a missing APP_TOKEN (new token every boot, everyone locked out after
// a redeploy), a master key sitting in the same volume as the ciphertext it
// protects, rate limits keyed on a proxy IP, and auth switched off in prod.
//
// Exit 0 = safe to deploy. Exit 1 = at least one blocker.
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AIW_DATA_DIR || path.join(__dirname, '..', 'data');
const prod = process.env.NODE_ENV === 'production';
const on = (v) => String(process.env[v] || '').toLowerCase() === 'true';

const blockers = [];
const warnings = [];
const ok = [];

// ---- auth -----------------------------------------------------------------
if (on('AUTH_DISABLED')) {
  (prod ? blockers : warnings).push([
    'AUTH_DISABLED=true',
    'Every API route is open to anyone who can reach the port. Only ever acceptable on a trusted loopback dev box.',
  ]);
} else if (!process.env.APP_TOKEN) {
  blockers.push([
    'APP_TOKEN is not set',
    'The server will generate a new token on every boot. On an ephemeral filesystem that means a redeploy locks every user out, '
    + 'and the token is only visible in the startup log. Generate one: openssl rand -base64 32',
  ]);
} else if (process.env.APP_TOKEN.length < 24) {
  warnings.push([
    `APP_TOKEN is short (${process.env.APP_TOKEN.length} chars)`,
    'Minimum accepted is 16, but a guessable token defeats the gate. 32+ random characters recommended.',
  ]);
} else if (/^(changeme|change_me|secret|password|token|test)/i.test(process.env.APP_TOKEN)) {
  blockers.push(['APP_TOKEN looks like a placeholder', 'Replace it with: openssl rand -base64 32']);
} else {
  ok.push(`APP_TOKEN set (${process.env.APP_TOKEN.length} chars)`);
}

// ---- credential vault ------------------------------------------------------
const keyPath = path.join(DATA_DIR, 'master.key');
if (process.env.MASTER_KEY) {
  if (!/^[0-9a-fA-F]{64}$/.test(process.env.MASTER_KEY)) {
    blockers.push(['MASTER_KEY is not 64 hex characters', 'It will be ignored and the on-disk key used instead. Generate: openssl rand -hex 32']);
  } else {
    ok.push('MASTER_KEY injected from the environment (not stored beside the ciphertext)');
    if (fs.existsSync(keyPath)) {
      warnings.push([
        'Both MASTER_KEY and data/master.key exist',
        'MASTER_KEY wins. Credentials saved under the OLD file key will fail to decrypt with a "master key mismatch" error. '
        + 'Re-enter those API keys, or unset MASTER_KEY to keep using the file.',
      ]);
    }
  }
} else if (prod) {
  warnings.push([
    'MASTER_KEY not set — using data/master.key',
    'The key that decrypts every stored provider key sits in the same directory as the ciphertext. Anyone who can read the '
    + 'volume or a backup has both. Prefer injecting MASTER_KEY from a secret manager.',
  ]);
}

// ---- proxy / TLS -----------------------------------------------------------
if (prod && !on('TRUST_PROXY')) {
  warnings.push([
    'TRUST_PROXY is not true',
    'If a reverse proxy or PaaS load balancer fronts this app, every request appears to come from the proxy IP, so all users '
    + 'share one rate-limit bucket and a single abuser throttles everyone. Set true ONLY when a trusted proxy sets X-Forwarded-For.',
  ]);
} else if (on('TRUST_PROXY')) {
  ok.push('TRUST_PROXY=true (rate limits keyed on the real client IP)');
}

if (prod && !on('FORCE_HSTS')) {
  warnings.push(['FORCE_HSTS is not true', 'HSTS is only sent when X-Forwarded-Proto is https. Set FORCE_HSTS=true behind TLS that does not forward it.']);
}

const fa = (process.env.FRAME_ANCESTORS || '').trim();
if (fa === '*') {
  blockers.push(['FRAME_ANCESTORS=*', 'Any site can iframe this app — that is clickjacking protection switched off. List specific origins instead.']);
} else if (fa) {
  warnings.push([`FRAME_ANCESTORS=${fa}`, 'Framing is allowed for these origins. Intended for hosted preview environments; unset it in production.']);
}

if (on('ALLOW_PRIVATE_EGRESS')) {
  blockers.push(['ALLOW_PRIVATE_EGRESS=true', 'The SSRF guard is disabled: a custom provider base URL can reach cloud metadata (169.254.169.254) and internal services.']);
}

// ---- persistence -----------------------------------------------------------
try {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const probe = path.join(DATA_DIR, '.preflight');
  fs.writeFileSync(probe, 'x');
  fs.unlinkSync(probe);
  ok.push(`data directory writable (${DATA_DIR})`);
  const mode = fs.statSync(DATA_DIR).mode & 0o777;
  if (mode & 0o077) warnings.push([`data/ is mode ${mode.toString(8)}`, 'It holds the encrypted vault and the access token. Expected 700.']);
} catch (e) {
  blockers.push([`data directory is not writable (${DATA_DIR})`, `${e.message} — the app cannot persist conversations, files or credentials.`]);
}

// ---- report ----------------------------------------------------------------
const pad = (s) => s.split('\n').join('\n      ');
console.log(`\nAI Workspace preflight — NODE_ENV=${process.env.NODE_ENV || '(unset)'}\n`);
for (const o of ok) console.log(`  PASS  ${o}`);
for (const [w, why] of warnings) console.log(`  WARN  ${w}\n        ${pad(why)}`);
for (const [b, why] of blockers) console.log(`  FAIL  ${b}\n        ${pad(why)}`);

console.log(`\n${ok.length} ok, ${warnings.length} warning(s), ${blockers.length} blocker(s).`);
if (blockers.length) {
  console.error('\nNot safe to deploy. Fix the blockers above.\n');
  process.exit(1);
}
console.log(warnings.length ? '\nDeployable, but review the warnings.\n' : '\nReady to deploy.\n');
