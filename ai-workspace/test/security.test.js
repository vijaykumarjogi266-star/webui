// Unit tests for the security primitives in lib/security.js.
// These were previously exercised only indirectly over HTTP, which meant a
// primitive could be wrong in a way no route happened to hit (SECURITY.md §7.6).
//
//   node --test test/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sec = require('../lib/security');

// ---------------------------------------------------------------------------
test('isPrivateIp — IPv4 ranges', () => {
  const priv = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '10.255.255.255',
    '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254',            // AWS/GCP/Azure metadata
    '100.64.0.1', '100.127.255.255', // CGNAT
    '0.0.0.0', '224.0.0.1', '239.255.255.255', '255.255.255.255',
  ];
  for (const ip of priv) assert.equal(sec.isPrivateIp(ip), true, `${ip} must be private`);

  const pub = ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '192.167.1.1', '100.63.255.255', '100.128.0.1', '223.255.255.255'];
  for (const ip of pub) assert.equal(sec.isPrivateIp(ip), false, `${ip} must be public`);
});

test('isPrivateIp — IPv6 incl. both IPv4-mapped spellings (V16 regression)', () => {
  const priv = [
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',   // what Node's URL parser normalises the above to
    '::ffff:7f00:1',      // 127.0.0.1 in hex
    '[::1]',              // bracketed
  ];
  for (const ip of priv) assert.equal(sec.isPrivateIp(ip), true, `${ip} must be private`);

  assert.equal(sec.isPrivateIp('::ffff:8.8.8.8'), false);
  assert.equal(sec.isPrivateIp('::ffff:808:808'), false); // 8.8.8.8 in hex
  assert.equal(sec.isPrivateIp('2606:4700::1111'), false);
});

// ---------------------------------------------------------------------------
test('assertSafeUrl — scheme, credentials, internal hosts', () => {
  const bad = [
    'file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'javascript:alert(1)',
    'data:text/plain,hi',
    'http://user:pass@example.com/',      // embedded credentials
    'http://localhost/v1', 'http://LOCALHOST/v1',
    'http://foo.localhost/v1',
    'http://svc.internal/v1', 'http://printer.local/v1',
    'http://metadata.google.internal/v1',
    'http://169.254.169.254/', 'http://127.0.0.1/', 'http://[::1]/',
    'http://[::ffff:169.254.169.254]/',
    'not a url', '', 'http://',
  ];
  for (const u of bad) {
    assert.throws(() => sec.assertSafeUrl(u, { requireHttps: false }), `${u} must be rejected`);
  }

  // These are fine (public, http(s), no creds).
  for (const u of ['https://api.openai.com/v1', 'https://openrouter.ai/api/v1', 'http://example.com:8080/v1']) {
    assert.ok(sec.assertSafeUrl(u, { requireHttps: false }), `${u} must be allowed`);
  }
});

test('assertSafeUrl — obfuscated IP encodings', () => {
  // Node's URL parser normalises these; the guard must catch whatever comes out.
  for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://0/', 'http://017700000001/']) {
    assert.throws(() => sec.assertSafeUrl(u, { requireHttps: false }), `${u} must be rejected`);
  }
});

test('assertSafeUrl — requireHttps enforced for credential-bearing URLs', () => {
  assert.throws(() => sec.assertSafeUrl('http://example.com/v1', { requireHttps: true }));
  assert.ok(sec.assertSafeUrl('https://example.com/v1', { requireHttps: true }));
});

test('assertResolvesPublic — rejects names that resolve into private space', async () => {
  // nip.io resolves 169.254.169.254.nip.io -> 169.254.169.254 (classic rebinding shape).
  await assert.rejects(sec.assertResolvesPublic('https://169.254.169.254.nip.io/v1'));
  await assert.rejects(sec.assertResolvesPublic('http://127.0.0.1.nip.io/v1'));
});

// ---------------------------------------------------------------------------
test('assertId — charset, length, prototype keys (V17 regression)', () => {
  for (const v of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']) {
    assert.throws(() => sec.assertId(v), `${v} must be rejected`);
  }
  for (const v of ['', '.', '..', 'a/b', 'a\\b', 'a b', 'a\0b', 'a'.repeat(65), '../etc', 'id;drop']) {
    assert.throws(() => sec.assertId(v), `${JSON.stringify(v)} must be rejected`);
  }
  for (const v of ['abc', 'a-b_c', '0123', crypto.randomUUID()]) {
    assert.equal(sec.assertId(v), v);
  }
});

test('assertGithubSegment — path injection (V5 regression)', () => {
  for (const v of ['../../users', 'a/b', '.', '..', 'a?b', 'a#b', '', 'x'.repeat(101), '__proto__', 'a b']) {
    assert.throws(() => sec.assertGithubSegment(v, 'owner'), `${JSON.stringify(v)} must be rejected`);
  }
  for (const v of ['torvalds', 'linux', 'my-repo.js', 'a_b.c-d']) {
    assert.equal(sec.assertGithubSegment(v, 'owner'), v);
  }
});

test('assertString — required, type, length bounds', () => {
  assert.throws(() => sec.assertString(undefined, 'x', 10));
  assert.throws(() => sec.assertString('', 'x', 10));
  assert.throws(() => sec.assertString(123, 'x', 10));
  assert.throws(() => sec.assertString({}, 'x', 10));
  assert.throws(() => sec.assertString('abcdefghijk', 'x', 10)); // too long
  assert.equal(sec.assertString('', 'x', 10, { required: false }), '');
  assert.equal(sec.assertString('ok', 'x', 10), 'ok');
});

test('sanitizeText — strips control chars, keeps normal text', () => {
  assert.equal(sec.sanitizeText('a\u0000b\u0007c\u001bd'), 'abcd');
  assert.equal(sec.sanitizeText('line1\nline2\ttab'), 'line1\nline2\ttab'); // \n and \t preserved
  assert.equal(sec.sanitizeText('héllo — ok ✓'), 'héllo — ok ✓');
  assert.equal(sec.sanitizeText(null), '');
});

// ---------------------------------------------------------------------------
test('validateImages — only inline data: images, bounded', () => {
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

  // SSRF vectors: remote/plain URLs must never be accepted (V3 regression).
  for (const u of ['http://169.254.169.254/', 'https://evil.com/x.png', 'file:///etc/passwd',
                   'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4=',
                   'javascript:alert(1)', '']) {
    assert.throws(() => sec.validateImages([{ name: 'x', dataUrl: u }]), `${u} must be rejected`);
  }

  assert.throws(() => sec.validateImages('nope'));                 // not a list
  assert.throws(() => sec.validateImages([{}, {}, {}, {}, {}]));   // >4 images
  assert.equal(sec.validateImages(null).length, 0);

  const ok = sec.validateImages([{ name: 'a\u0000.png', dataUrl: px }]);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].name, 'a.png');       // control char stripped
  assert.ok(ok[0].dataUrl.startsWith('data:image/png;base64,'));

  // Oversized image (>6MB decoded) rejected.
  const huge = 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024);
  assert.throws(() => sec.validateImages([{ name: 'big', dataUrl: huge }]));
});

test('validateIdList — bounds and element validation', () => {
  assert.deepEqual(sec.validateIdList(null, 'fileIds'), []);
  assert.throws(() => sec.validateIdList('x', 'fileIds'));
  assert.throws(() => sec.validateIdList(new Array(51).fill('a'), 'fileIds'));
  assert.throws(() => sec.validateIdList(['ok', '../bad'], 'fileIds'));
  assert.throws(() => sec.validateIdList(['__proto__'], 'fileIds'));
  assert.deepEqual(sec.validateIdList(['a', 'b-c'], 'fileIds'), ['a', 'b-c']);
});

// ---------------------------------------------------------------------------
test('resolveStatic — traversal, null bytes, symlink escape, non-files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-static-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-secret-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'a.css'), 'body{}');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'MASTER_KEY');
  // A sibling dir sharing the root's name prefix — the classic startsWith() bug.
  const sibling = root + '-old';
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'leak.txt'), 'leak');
  try { fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt')); } catch {}

  // Allowed
  assert.ok(sec.resolveStatic(root, '/'));
  assert.ok(sec.resolveStatic(root, '/index.html'));
  assert.ok(sec.resolveStatic(root, '/./index.html'));
  assert.ok(sec.resolveStatic(root, '/sub/a.css'));

  // Blocked
  const blocked = [
    '/../secret.txt', '/../../etc/passwd', '/..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/etc/passwd', '/sub/../../etc/passwd',
    '/index.html\0.png', '/index.html%00.png',
    '/link.txt',                 // symlink pointing outside the root
    '/sub',                      // directory, not a file
    '/nope.html',                // missing
    '/../' + path.basename(sibling) + '/leak.txt', // prefix-sibling escape
  ];
  for (const p of blocked) {
    assert.equal(sec.resolveStatic(root, p), null, `${p} must be blocked`);
  }

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(sibling, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
test('timingSafeEqual — empty never authenticates (V20 regression)', () => {
  assert.equal(sec.timingSafeEqual('', ''), false);
  assert.equal(sec.timingSafeEqual('', 'x'), false);
  assert.equal(sec.timingSafeEqual('x', ''), false);
  assert.equal(sec.timingSafeEqual(null, null), false);
  assert.equal(sec.timingSafeEqual(undefined, undefined), false);
  assert.equal(sec.timingSafeEqual('abc', 'abd'), false);
  assert.equal(sec.timingSafeEqual('abc', 'abcd'), false); // length mismatch, no throw
  assert.equal(sec.timingSafeEqual('secret-token', 'secret-token'), true);
});

test('loadAppToken — a too-short APP_TOKEN fails loudly, never silently ignored (V32)', () => {
  const prev = process.env.APP_TOKEN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiw-token-'));

  process.env.APP_TOKEN = 'tooshort';
  assert.throws(() => sec.loadAppToken(dir), /too short/i,
    'a short APP_TOKEN must abort startup, not fall back to a generated token');

  process.env.APP_TOKEN = 'a-sufficiently-long-token';
  assert.equal(sec.loadAppToken(dir), 'a-sufficiently-long-token');

  // Unset: a token is generated and persisted with restrictive permissions.
  delete process.env.APP_TOKEN;
  const gen = sec.loadAppToken(dir);
  assert.ok(gen && gen.length >= 16);
  const mode = fs.statSync(path.join(dir, 'app.token')).mode & 0o777;
  assert.equal(mode, 0o600, `app.token mode is ${mode.toString(8)}, expected 600`);
  assert.equal(sec.loadAppToken(dir), gen, 'generated token must be stable across calls');

  if (prev === undefined) delete process.env.APP_TOKEN; else process.env.APP_TOKEN = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session HMAC — verifies, expires, rejects tampering and cross-token replay', () => {
  const tok = 'a-very-secret-token-value';
  const s = sec.mintSession(tok);
  assert.equal(sec.verifySession(tok, s), true);

  // Wrong token must not verify a session minted under another one.
  assert.equal(sec.verifySession('different-token-value', s), false);

  // Tampered expiry (extend the session) must fail the MAC.
  const [exp, mac] = s.split('.');
  const forged = `${Number(exp) + 86400000}.${mac}`;
  assert.equal(sec.verifySession(tok, forged), false);

  // Tampered MAC.
  assert.equal(sec.verifySession(tok, `${exp}.${'A'.repeat(mac.length)}`), false);

  // Garbage / missing.
  for (const v of ['', null, undefined, 'nodot', 'abc.def', '.', '0.x']) {
    assert.equal(sec.verifySession(tok, v), false, `${JSON.stringify(v)} must not verify`);
  }

  // Already expired.
  const past = Date.now() - 1000;
  const crypto2 = require('crypto');
  const pmac = crypto2.createHmac('sha256', tok).update(String(past)).digest('base64url');
  assert.equal(sec.verifySession(tok, `${past}.${pmac}`), false);
});

test('parseCookies — multiple, spacing, encoded values, malformed', () => {
  assert.deepEqual(sec.parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(sec.parseCookies('  a = 1 ;b=2  '), { a: '1', b: '2' });
  assert.deepEqual(sec.parseCookies('a=%20x%3D'), { a: ' x=' });
  assert.deepEqual(sec.parseCookies(''), {});
  assert.deepEqual(sec.parseCookies(undefined), {});
  assert.deepEqual(sec.parseCookies('novalue'), {});
});

// ---------------------------------------------------------------------------
const mkReq = (method, headers = {}) => ({ method, headers, socket: { remoteAddress: '10.1.2.3' } });

test('checkOrigin — CSRF incl. X-Forwarded-Host forgery (V15 regression)', () => {
  const prev = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;

  // Safe methods always pass.
  assert.equal(sec.checkOrigin(mkReq('GET', { origin: 'https://evil.example' })), true);

  // Same-origin passes.
  assert.equal(sec.checkOrigin(mkReq('POST', { origin: 'http://app.test', host: 'app.test' })), true);

  // Cross-origin blocked.
  assert.equal(sec.checkOrigin(mkReq('POST', { origin: 'https://evil.example', host: 'app.test' })), false);

  // The V15 bypass: attacker-supplied X-Forwarded-Host must be ignored when untrusted.
  assert.equal(sec.checkOrigin(mkReq('POST', {
    origin: 'https://evil.example', host: 'app.test', 'x-forwarded-host': 'evil.example',
  })), false);

  // Origin: null (sandboxed iframe / data: URL) blocked.
  assert.equal(sec.checkOrigin(mkReq('POST', { origin: 'null', host: 'app.test' })), false);

  // No Origin at all = non-browser client; allowed here, auth token still required.
  assert.equal(sec.checkOrigin(mkReq('POST', { host: 'app.test' })), true);

  // Missing Host must not match an empty origin host.
  assert.equal(sec.checkOrigin(mkReq('POST', { origin: 'https://evil.example' })), false);

  // With a trusted proxy, X-Forwarded-Host is honoured.
  process.env.TRUST_PROXY = 'true';
  assert.equal(sec.checkOrigin(mkReq('POST', {
    origin: 'https://app.test', host: 'internal:3000', 'x-forwarded-host': 'app.test',
  })), true);

  if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
});

test('ALLOWED_ORIGINS allowlist is honoured', () => {
  const prev = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://ai.example.com, https://other.test';
  assert.equal(sec.checkOrigin(mkReq('POST', { origin: 'https://ai.example.com', host: 'internal' })), true);
  assert.equal(sec.checkOrigin(mkReq('POST', { origin: 'https://nope.example.com', host: 'internal' })), false);
  if (prev === undefined) delete process.env.ALLOWED_ORIGINS; else process.env.ALLOWED_ORIGINS = prev;
});

test('clientIp — X-Forwarded-For only trusted behind TRUST_PROXY', () => {
  const prev = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  const req = mkReq('POST', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
  assert.equal(sec.clientIp(req), '10.1.2.3'); // socket address, header ignored

  process.env.TRUST_PROXY = 'true';
  assert.equal(sec.clientIp(req), '1.2.3.4');  // first hop honoured
  if (prev === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
});

test('rateLimit — allows under the cap, blocks over it, isolates per IP and per bucket', () => {
  const name = 'unit-' + Math.random().toString(36).slice(2);
  const a = { method: 'POST', headers: {}, socket: { remoteAddress: '203.0.113.1' } };
  const b = { method: 'POST', headers: {}, socket: { remoteAddress: '203.0.113.2' } };

  for (let i = 0; i < 5; i++) assert.equal(sec.rateLimit(a, name, 5, 60000), true, `attempt ${i + 1}`);
  assert.equal(sec.rateLimit(a, name, 5, 60000), false, '6th must be blocked');

  // A different IP has its own bucket.
  assert.equal(sec.rateLimit(b, name, 5, 60000), true);
  // A different route class has its own bucket.
  assert.equal(sec.rateLimit(a, name + '-other', 5, 60000), true);
});

test('attemptCount / resetAttempts — backoff counter (V22)', () => {
  const name = 'unit-login-' + Math.random().toString(36).slice(2);
  const req = { method: 'POST', headers: {}, socket: { remoteAddress: '203.0.113.9' } };
  assert.equal(sec.attemptCount(req, name, 60000), 1);
  assert.equal(sec.attemptCount(req, name, 60000), 2);
  assert.equal(sec.attemptCount(req, name, 60000), 3);
  sec.resetAttempts(req, name);
  assert.equal(sec.attemptCount(req, name, 60000), 1, 'successful login must clear the counter');
});

// ---------------------------------------------------------------------------
test('frame-ancestors defaults to none; FRAME_ANCESTORS is opt-in only (V35)', () => {
  const prev = process.env.FRAME_ANCESTORS;
  delete process.env.FRAME_ANCESTORS;

  const set = {};
  sec.securityHeaders(mkReq('GET'), { setHeader: (k, v) => { set[k.toLowerCase()] = v; } });
  assert.ok(set['content-security-policy'].includes("frame-ancestors 'none'"), 'default must be none');
  assert.equal(set['x-frame-options'], 'DENY', 'XFO must be sent when framing is denied');
  assert.equal(set['cross-origin-resource-policy'], 'same-origin');

  // Opt in: CSP carries the allowlist and XFO is dropped (it has no allowlist form).
  process.env.FRAME_ANCESTORS = 'https://*.e2b.app';
  const set2 = {};
  sec.securityHeaders(mkReq('GET'), { setHeader: (k, v) => { set2[k.toLowerCase()] = v; } });
  assert.ok(set2['content-security-policy'].includes('frame-ancestors https://*.e2b.app'));
  assert.ok(!('x-frame-options' in set2), 'XFO must be dropped when specific ancestors are allowed');
  assert.equal(set2['cross-origin-resource-policy'], 'cross-origin');

  if (prev === undefined) delete process.env.FRAME_ANCESTORS; else process.env.FRAME_ANCESTORS = prev;
});

test('network failures become actionable messages, not "fetch failed" (V36)', () => {
  const { normalizeNetworkError } = require('../lib/providers');
  const cases = [
    [{ cause: { code: 'ENOTFOUND' } }, /resolve|DNS|connection/i],
    [{ cause: { code: 'ECONNREFUSED' } }, /refused/i],
    [{ cause: { code: 'ECONNRESET' } }, /closed unexpectedly|network|firewall/i],
    [{ name: 'TimeoutError' }, /did not respond in time/i],
    [{ message: 'fetch failed' }, /Could not reach the provider/i],
  ];
  for (const [err, re] of cases) {
    const out = normalizeNetworkError(err);
    assert.equal(out.code, 'network');
    assert.match(out.message, re);
    assert.ok(!/^fetch failed$/i.test(out.message), 'raw "fetch failed" leaked to the user');
  }
});

test('securityHeaders — CSP and hardening headers set', () => {
  const set = {};
  const res = { setHeader: (k, v) => { set[k.toLowerCase()] = v; } };
  sec.securityHeaders(mkReq('GET'), res);

  const csp = set['content-security-policy'];
  for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'",
                   "base-uri 'none'", "form-action 'none'", "connect-src 'self'"]) {
    assert.ok(csp.includes(d), `CSP must contain ${d}`);
  }
  // V33: scripts are external files now, so inline script must be forbidden.
  assert.ok(csp.includes("script-src 'self'"), 'script-src must be present');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "script-src must NOT allow 'unsafe-inline'");
  assert.ok(!/script-src[^;]*unsafe-eval/.test(csp), "script-src must NOT allow 'unsafe-eval'");
  assert.equal(set['x-content-type-options'], 'nosniff');
  assert.equal(set['x-frame-options'], 'DENY');
  assert.equal(set['referrer-policy'], 'no-referrer');
  assert.ok(!set['strict-transport-security'], 'no HSTS on plain http');

  // HSTS appears behind TLS.
  const set2 = {};
  sec.securityHeaders(mkReq('GET', { 'x-forwarded-proto': 'https' }), { setHeader: (k, v) => { set2[k.toLowerCase()] = v; } });
  assert.ok(set2['strict-transport-security'].includes('max-age=31536000'));
});
