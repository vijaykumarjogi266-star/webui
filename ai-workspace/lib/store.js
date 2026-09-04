// Zero-dependency JSON store + AES-256-GCM secret encryption (local master key).
// Production plan escalates this to OCI Vault/KMS envelope encryption (build plan §13).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
  catch { return fallback; }
}

const COLLECTIONS = ['credentials', 'conversations', 'messages', 'files', 'chunks', 'repos', 'repoFiles', 'feedback', 'usage'];
const db = {};
for (const c of COLLECTIONS) db[c] = loadJson(c + '.json', (c === 'messages' || c === 'repoFiles') ? {} : []);

let saveTimer = null;
function atomicWrite(name, data) {
  const fp = path.join(DATA_DIR, name);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, fp); // atomic on POSIX: a crash never leaves a torn file
}
function persistNow() {
  clearTimeout(saveTimer);
  for (const c of COLLECTIONS) atomicWrite(c + '.json', JSON.stringify(db[c]));
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 200);
}

// ---- master key (demo-grade; production: OCI KMS-wrapped envelope keys) ----
const KEY_PATH = path.join(DATA_DIR, 'master.key');
let MASTER;
if (fs.existsSync(KEY_PATH)) {
  MASTER = Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
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
