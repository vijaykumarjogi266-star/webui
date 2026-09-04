// Security layer for the AI Workspace build.
// Added after an adversarial (ethical-hacking) review of server.js — see SECURITY.md.
// Covers: auth gate, CSRF/origin binding, SSRF egress guard, rate limiting,
// security headers/CSP, input validation, and safe static-file resolution.
'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 1. Access token (single-tenant BYOK app: one shared secret, not a user system)
// ---------------------------------------------------------------------------
const AUTH_DISABLED = String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'aiw_session';

function loadAppToken(dataDir) {
  if (process.env.APP_TOKEN && process.env.APP_TOKEN.length >= 16) return process.env.APP_TOKEN;
  if (AUTH_DISABLED) return null;
  const p = path.join(dataDir, 'app.token');
  try {
    const t = fs.readFileSync(p, 'utf8').trim();
    if (t.length >= 16) return t;
  } catch { /* generate below */ }
  const t = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(p, t, { mode: 0o600 });
  console.log('\n  Access token generated (first run). Open the UI and paste:\n\n    %s\n\n  Stored at %s — set APP_TOKEN to override, AUTH_DISABLED=true to disable.\n', t, p);
  return t;
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length === 0 || bb.length === 0) return false; // empty never authenticates
  if (ba.length !== bb.length) {
    // still burn a comparison so length isn't leaked by timing alone
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// Session cookie = HMAC(token, expiry) — no server-side session table needed.
function mintSession(token) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const mac = crypto.createHmac('sha256', token).update(String(exp)).digest('base64url');
  return `${exp}.${mac}`;
}
function verifySession(token, value) {
  if (!value) return false;
  const [expStr, mac] = String(value).split('.');
  const exp = Number(expStr);
  if (!exp || Number.isNaN(exp) || Date.now() > exp) return false;
  const want = crypto.createHmac('sha256', token).update(String(exp)).digest('base64url');
  return timingSafeEqual(mac, want);
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. CSRF: same-origin binding for every state-changing request
// ---------------------------------------------------------------------------
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function allowedOrigins() {
  return String(process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
function trustProxy() { return String(process.env.TRUST_PROXY || '').toLowerCase() === 'true'; }
function checkOrigin(req) {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = req.headers.origin;
  // 'null' is a real value browsers send from sandboxed iframes / data: URLs.
  if (!origin || origin === 'null') return origin !== 'null'; // no Origin = non-browser (token still required); null = reject
  const extra = allowedOrigins();
  if (extra.includes(origin.replace(/\/+$/, ''))) return true;
  try {
    const o = new URL(origin);
    // X-Forwarded-Host is attacker-controlled unless a trusted proxy sets it.
    // Honouring it unconditionally let `Origin: evil` + `X-Forwarded-Host: evil` pass.
    const host = (trustProxy() && req.headers['x-forwarded-host'])
      ? String(req.headers['x-forwarded-host']).split(',')[0].trim()
      : (req.headers.host || '');
    return !!host && o.host === host;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// 3. SSRF guard for outbound URLs (custom provider base URLs, image URLs)
// ---------------------------------------------------------------------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;          // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                         // multicast / reserved
    return false;
  }
  const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true;
  // IPv4-mapped IPv6. Node's URL parser compresses ::ffff:169.254.169.254 to the
  // hex form ::ffff:a9fe:a9fe, so BOTH spellings must be unmapped and re-checked.
  if (s.startsWith('::ffff:') || s.startsWith('::')) {
    const tail = s.replace(/^::(ffff:)?/, '');
    if (net.isIPv4(tail)) return isPrivateIp(tail);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
      return isPrivateIp([a >> 8, a & 255, b >> 8, b & 255].join('.'));
    }
  }
  return false;
}

const ALLOW_PRIVATE_EGRESS = String(process.env.ALLOW_PRIVATE_EGRESS || '').toLowerCase() === 'true';

// Validates scheme/host shape synchronously; resolveGuard() also checks DNS.
function assertSafeUrl(raw, { requireHttps = true } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw bad('That URL is not valid.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Only http(s) URLs are allowed.');
  if (requireHttps && u.protocol !== 'https:') throw bad('Use an https:// URL — an API key must never travel in cleartext.');
  if (u.username || u.password) throw bad('Credentials embedded in the URL are not allowed.');
  if (ALLOW_PRIVATE_EGRESS) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw bad('That URL has no host.');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw bad('That host is blocked (internal network).');
  if ((net.isIP(host) && isPrivateIp(host))) throw bad('That host is blocked (private or link-local address).');
  return u;
}
async function assertResolvesPublic(raw) {
  const u = assertSafeUrl(raw, { requireHttps: false });
  if (ALLOW_PRIVATE_EGRESS || net.isIP(u.hostname)) return u;
  let addrs = [];
  try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { throw bad('That host could not be resolved.'); }
  if (addrs.some((a) => isPrivateIp(a.address))) throw bad('That host resolves to a private address (blocked).');
  return u;
}

// ---------------------------------------------------------------------------
// 4. Rate limiting (token bucket, per IP + route class)
// ---------------------------------------------------------------------------
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now - v.at > 10 * 60 * 1000) buckets.delete(k);
}, 60 * 1000).unref?.();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf && trustProxy()) {
    return String(xf).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}
function rateLimit(req, name, limit, windowMs) {
  const key = `${name}:${clientIp(req)}`;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) { buckets.set(key, { start: now, n: 1, at: now }); return true; }
  b.n++; b.at = now;
  return b.n <= limit;
}

// ---------------------------------------------------------------------------
// 5. Security headers
// ---------------------------------------------------------------------------
// The UI is a single self-contained HTML file (inline <script>/<style>), so a
// nonce-less 'unsafe-inline' is required for scripts; everything else is locked
// down: no remote origins, no framing, no plugins, no base-tag hijacking.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (req.headers['x-forwarded-proto'] === 'https' || process.env.FORCE_HSTS === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

// ---------------------------------------------------------------------------
// 6. Input validation helpers
// ---------------------------------------------------------------------------
function bad(message, code = 'invalid_input', status = 400) {
  return Object.assign(new Error(message), { status, code });
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Keys that would collide with Object.prototype when used as a map index
// (db.messages[id], db.repoFiles[id]). Assigning '__proto__' silently discards
// the write, so these must never reach the store.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);
const GH_SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

function assertId(v, label = 'id') {
  const s = String(v || '');
  if (!ID_RE.test(s) || s === '.' || s === '..' || UNSAFE_KEYS.has(s)) throw bad(`Invalid ${label}.`);
  return s;
}
function assertGithubSegment(v, label) {
  const s = String(v || '').trim();
  if (!GH_SEGMENT_RE.test(s) || s === '.' || s === '..' || UNSAFE_KEYS.has(s)) throw bad(`Invalid ${label}. Use the plain owner/repo name.`);
  return s;
}
function assertString(v, label, max, { required = true, min = 0 } = {}) {
  if (v == null || v === '') {
    if (required) throw bad(`${label} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${label} must be text.`);
  if (v.length < min) throw bad(`${label} is too short.`);
  if (v.length > max) throw bad(`${label} is too long (max ${max} characters).`);
  return v;
}
// Strip the sentinel used by the client markdown renderer + other control chars
// so model/document content cannot smuggle renderer placeholders or ANSI codes.
function sanitizeText(s) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
function validateImages(images) {
  if (!images) return [];
  if (!Array.isArray(images)) throw bad('images must be a list.');
  if (images.length > MAX_IMAGES) throw bad(`At most ${MAX_IMAGES} images per message.`);
  return images.map((im, i) => {
    const url = im && typeof im.dataUrl === 'string' ? im.dataUrl : '';
    // Only inline data: images — a remote URL here would make the provider (or us)
    // fetch attacker-chosen hosts, and would leak internal endpoints.
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
    if (!m) throw bad(`Attachment ${i + 1} must be an inline PNG/JPEG/GIF/WebP image.`);
    const bytes = Math.floor(m[2].replace(/\s/g, '').length * 3 / 4);
    if (bytes > MAX_IMAGE_BYTES) throw bad(`Attachment ${i + 1} exceeds the 6 MB image limit.`);
    return { name: sanitizeText(String(im.name || 'image')).slice(0, 120), dataUrl: url.replace(/\s/g, '') };
  });
}

function validateIdList(list, label) {
  if (!list) return [];
  if (!Array.isArray(list)) throw bad(`${label} must be a list.`);
  if (list.length > 50) throw bad(`Too many ${label}.`);
  return list.map((v) => assertId(v, label));
}

// ---------------------------------------------------------------------------
// 7. Safe static file resolution (traversal + symlink escape + null bytes)
// ---------------------------------------------------------------------------
function resolveStatic(rootDir, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0')) return null;
  if (p === '/' || p === '') p = '/index.html';
  const fp = path.resolve(rootDir, '.' + path.posix.normalize(p));
  const rootWithSep = path.resolve(rootDir) + path.sep;
  if (!fp.startsWith(rootWithSep)) return null;
  let st;
  try { st = fs.statSync(fp); } catch { return null; }
  if (!st.isFile()) return null;
  // Reject symlinks pointing outside the public root.
  let real;
  try { real = fs.realpathSync(fp); } catch { return null; }
  if (!real.startsWith(fs.realpathSync(path.resolve(rootDir)) + path.sep)) return null;
  return real;
}

module.exports = {
  UNSAFE_KEYS, trustProxy,
  AUTH_DISABLED, COOKIE, TOKEN_TTL_MS,
  loadAppToken, timingSafeEqual, mintSession, verifySession, parseCookies,
  checkOrigin, SAFE_METHODS,
  assertSafeUrl, assertResolvesPublic, isPrivateIp,
  rateLimit, clientIp,
  securityHeaders, CSP,
  bad, assertId, assertGithubSegment, assertString, sanitizeText,
  validateImages, validateIdList, resolveStatic,
};
