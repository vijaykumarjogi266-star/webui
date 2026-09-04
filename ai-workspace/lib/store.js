// Zero-dependency JSON store + AES-256-GCM secret encryption (local master key).
// Production plan escalates this to OCI Vault/KMS envelope encryption (build plan §13).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* best effort on odd filesystems */ }

function loadJson(name, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
    // Shape guard: a corrupted/tampered file must not turn into prototype-polluting
    // or wrongly-typed state at boot.
    if (Array.isArray(fallback) ? !Array.isArray(parsed) : (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) return fallback;
    if (!Array.isArray(parsed)) { delete parsed.__proto__; delete parsed.constructor; }
    return parsed;
  } catch { return fallback; }
}

const COLLECTIONS = ['credentials', 'conversations', 'messages', 'files', 'chunks', 'repos', 'repoFiles', 'feedback', 'usage'];
const db = {};
for (const c of COLLECTIONS) db[c] = loadJson(c + '.json', (c === 'messages' || c === 'repoFiles') ? {} : []);

let saveTimer = null;
function atomicWrite(name, data) {
  const fp = path.join(DATA_DIR, name);
  const tmp = fp + '.tmp';
  // The data dir can vanish under a running process (a volume unmount, an
  // operator clearing state). Recreate it rather than throwing mid-shutdown,
  // where the exception would mask the real reason we were exiting.
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, fp); // atomic on POSIX: a crash never leaves a torn file
}
function persistNow() {
  clearTimeout(saveTimer);
  for (const c of COLLECTIONS) {
    // One unwritable collection must not abort the rest of the flush.
    try { atomicWrite(c + '.json', JSON.stringify(db[c])); }
    catch (e) { console.error(`[store] failed to persist ${c}.json:`, e.message); }
  }
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 200);
}

// ---- master key (demo-grade; production: OCI KMS-wrapped envelope keys) ----
const KEY_PATH = path.join(DATA_DIR, 'master.key');
let MASTER;
if (process.env.MASTER_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.MASTER_KEY)) {
  MASTER = Buffer.from(process.env.MASTER_KEY, 'hex'); // preferred: injected by a secret manager
} else if (fs.existsSync(KEY_PATH)) {
  MASTER = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
  if (MASTER.length !== 32) throw new Error('data/master.key is corrupt (expected 32 bytes hex).');
  try { fs.chmodSync(KEY_PATH, 0o600); } catch {}
} else {
  MASTER = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, MASTER.toString('hex'), { mode: 0o600 });
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MASTER, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function decryptSecret(enc) {
  if (!enc || typeof enc !== 'object' || !enc.iv || !enc.ct || !enc.tag) throw new Error('Stored credential is unreadable.');
  // A GCM auth-tag failure here almost always means the master key changed
  // (MASTER_KEY introduced/rotated, or data/master.key restored from a
  // different backup) rather than corruption. Say so: the raw OpenSSL string
  // "Unsupported state or unable to authenticate data" sends operators hunting
  // a disk fault when the fix is to restore the old key or re-enter the API key.
  try {
    return decryptSecretInner(enc);
  } catch (e) {
    const err = new Error(
      'This saved key could not be decrypted. It was encrypted with a different master key — '
      + 'restore the previous MASTER_KEY (or data/master.key), or delete the credential and re-enter the API key.'
    );
    err.status = 409;
    err.code = 'master_key_mismatch';
    throw err;
  }
}
function decryptSecretInner(enc) {
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER, Buffer.from(enc.iv, 'base64'));
  d.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc.ct, 'base64')), d.final()]).toString('utf8');
}

function maskKey(key) {
  if (!key) return '';
  const tail = key.slice(-4);
  const head = key.slice(0, key.startsWith('sk-or-') ? 6 : (key.startsWith('gsk_') ? 4 : 3));
  return `${head}…${tail}`;
}

const uid = () => crypto.randomUUID();
module.exports = { db, persist, persistNow, encryptSecret, decryptSecret, maskKey, uid, DATA_DIR };
