#!/usr/bin/env node
// Fuzzer for lib/pdf.js — bespoke binary parsing on fully attacker-controlled
// bytes, and the highest-yield target in this codebase (V28 came from here).
//
//   node test/pdf.fuzz.js               # 3000 cases, deterministic seed
//   FUZZ_ITER=50000 node test/pdf.fuzz.js
//   FUZZ_SEED=12345 node test/pdf.fuzz.js
//
// A case FAILS if extractPdf() throws (it must return {ok:false} instead),
// takes longer than FUZZ_MAX_MS (ReDoS / algorithmic blowup), or grows the heap
// past FUZZ_MAX_HEAP_MB (decompression bomb / unbounded buffering).
'use strict';
const zlib = require('zlib');
const { extractPdf } = require('../lib/pdf');

const ITER = Number(process.env.FUZZ_ITER || 3000);
const MAX_MS = Number(process.env.FUZZ_MAX_MS || 2000);
const MAX_HEAP_MB = Number(process.env.FUZZ_MAX_HEAP_MB || 256);
let seed = Number(process.env.FUZZ_SEED || 0xC0FFEE);

// xorshift32 — deterministic so a failing run is reproducible from its seed.
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5;  seed >>>= 0;
  return seed / 0x100000000;
}
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];

// Fragments drawn from real PDF structure, so the fuzzer spends its time in the
// parser's interesting paths rather than being rejected at the %PDF check.
const FRAGMENTS = [
  '%PDF-1.4\n', '%PDF-1.7\n', '%PDF\n',
  '1 0 obj', '2 0 obj', '999999 0 obj', '-1 0 obj', '0 0 obj',
  'endobj', 'stream\n', 'stream\r\n', 'stream\r', 'endstream',
  '<</Type/Page>>', '<</Type/Pages/Kids[1 0 R 2 0 R]>>', '<</Type/Page/Contents 2 0 R>>',
  '<</Type/Pages/Kids[]>>', '<</Contents[1 0 R 2 0 R 3 0 R]>>',
  '/FlateDecode', '/Filter/FlateDecode', '/Length 999999',
  'BT', 'ET', 'BT ET', '(hello) Tj', '[(a)-250(b)] TJ', "(x) '", '(y) "',
  '0 -14 Td', '1 0 0 1 72 720 Tm', '-99999 99999 Td',
  '\\\\', '\\(', '\\)', '\\377', '\\0', '(', ')', '[', ']', '<<', '>>',
  '\x00', '\xff', '\n', '\r', '\t', ' ',
  'trailer', 'xref', 'startxref', '%%EOF',
  '/Kids[1 0 R]', '/Parent 1 0 R',
];

function randomBytes(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = ri(256);
  return b;
}

// ---- case generators -------------------------------------------------------
const GENERATORS = {
  // Structured junk assembled from real fragments.
  fragments() {
    const parts = ['%PDF-1.4\n'];
    const n = 1 + ri(60);
    for (let i = 0; i < n; i++) parts.push(pick(FRAGMENTS));
    return Buffer.from(parts.join(''), 'latin1');
  },

  // Pure noise with a valid header.
  noise() {
    return Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), randomBytes(ri(4096))]);
  },

  // Valid-ish object wrapping a genuinely deflated stream.
  flate() {
    const payload = randomBytes(ri(2048));
    let z;
    try { z = zlib.deflateSync(payload); } catch { z = payload; }
    return Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj<</Type/Page/Contents 2 0 R>>endobj\n2 0 obj<</Filter/FlateDecode>>stream\n', 'latin1'),
      z, Buffer.from('\nendstream endobj\n', 'latin1'),
    ]);
  },

  // Corrupted deflate stream — inflate must fail closed, not throw.
  badFlate() {
    const z = zlib.deflateSync(randomBytes(512));
    z[ri(z.length)] ^= 0xff; // flip a byte
    return Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj<</Type/Page/Contents 2 0 R>>endobj\n2 0 obj<</Filter/FlateDecode>>stream\n', 'latin1'),
      z, Buffer.from('\nendstream endobj\n', 'latin1'),
    ]);
  },

  // Decompression bomb of varying magnitude (V28 regression).
  bomb() {
    const mb = 1 + ri(120);
    const z = zlib.deflateSync(Buffer.alloc(mb * 1024 * 1024));
    return Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj<</Type/Page/Contents 2 0 R>>endobj\n2 0 obj<</Filter/FlateDecode>>stream\n', 'latin1'),
      z, Buffer.from('\nendstream endobj\n', 'latin1'),
    ]);
  },

  // Pathological repetition — targets catastrophic backtracking.
  repetition() {
    const unit = pick(['BT', '(', '\\\\', '\\(', '[', '<<', 'stream\n', '1 0 obj', '(a)Tj', ' ']);
    return Buffer.from('%PDF-1.4\n' + unit.repeat(1 + ri(40000)), 'latin1');
  },

  // Deeply nested / cyclic page trees.
  pageTree() {
    const n = 2 + ri(200);
    let out = '%PDF-1.4\n';
    for (let i = 1; i <= n; i++) {
      const kid = ri(n) + 1;            // may point backwards -> cycles
      out += `${i} 0 obj<</Type/Pages/Kids[${kid} 0 R]/Parent ${ri(n) + 1} 0 R>>endobj\n`;
    }
    return Buffer.from(out, 'latin1');
  },

  // Huge declared /Length vs tiny real stream, and unterminated streams.
  lengthLies() {
    return Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Page/Contents 2 0 R>>endobj\n'
      + `2 0 obj<</Length ${ri(1e9)}>>stream\n` + 'x'.repeat(ri(2048)),
      'latin1');
  },

  // Text operators with adversarial escape sequences.
  escapes() {
    const inner = Array.from({ length: 1 + ri(400) }, () => pick(['\\\\', '\\(', '\\)', '\\377', '\\0', '\\n', 'a', '(', ')'])).join('');
    return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Page/Contents 2 0 R>>endobj\n2 0 obj<<>>stream\nBT (${inner}) Tj ET\nendstream endobj\n`, 'latin1');
  },

  // Truncation of an otherwise well-formed document.
  truncated() {
    const full = GENERATORS.flate();
    return full.subarray(0, ri(full.length));
  },
};

const NAMES = Object.keys(GENERATORS);

// ---- run -------------------------------------------------------------------
const failures = [];
const stats = Object.fromEntries(NAMES.map((n) => [n, { n: 0, maxMs: 0 }]));
let slowest = { ms: 0, kind: null };

console.log(`pdf fuzz — ${ITER} cases, seed=0x${seed.toString(16)}, max ${MAX_MS}ms / ${MAX_HEAP_MB}MB per case`);
const startedAt = Date.now();

for (let i = 0; i < ITER; i++) {
  const kind = pick(NAMES);
  let buf;
  try { buf = GENERATORS[kind](); } catch (e) { failures.push({ i, kind, why: 'generator threw: ' + e.message }); continue; }

  const heapBefore = process.memoryUsage().heapUsed;
  const t = process.hrtime.bigint();
  let out, threw = null;
  try {
    out = extractPdf(buf);
  } catch (e) {
    threw = e;
  }
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const heapMb = (process.memoryUsage().heapUsed - heapBefore) / 1048576;

  stats[kind].n++;
  if (ms > stats[kind].maxMs) stats[kind].maxMs = ms;
  if (ms > slowest.ms) slowest = { ms, kind };

  if (threw) {
    failures.push({ i, kind, why: `threw ${threw.name}: ${threw.message}`, size: buf.length });
  } else if (ms > MAX_MS) {
    failures.push({ i, kind, why: `took ${ms.toFixed(0)}ms (limit ${MAX_MS}ms)`, size: buf.length });
  } else if (heapMb > MAX_HEAP_MB) {
    failures.push({ i, kind, why: `grew heap ${heapMb.toFixed(0)}MB (limit ${MAX_HEAP_MB}MB)`, size: buf.length });
  } else if (out && typeof out.ok !== 'boolean') {
    failures.push({ i, kind, why: 'returned a malformed result object', size: buf.length });
  } else if (out && out.ok && !Array.isArray(out.pages)) {
    failures.push({ i, kind, why: 'ok=true but pages is not an array', size: buf.length });
  }

  if (failures.length > 20) break; // stop early; the point is made
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\nper-generator worst case:`);
for (const n of NAMES) console.log(`  ${n.padEnd(12)} ${String(stats[n].n).padStart(5)} cases   max ${stats[n].maxMs.toFixed(1)}ms`);
console.log(`\nslowest overall: ${slowest.ms.toFixed(1)}ms (${slowest.kind})`);

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem case(s) in ${elapsed}s:`);
  for (const f of failures.slice(0, 20)) console.error(`  #${f.i} [${f.kind}] ${f.why}${f.size != null ? ` (input ${f.size}B)` : ''}`);
  console.error(`\nReproduce with: FUZZ_SEED=${process.env.FUZZ_SEED || 0xC0FFEE} node test/pdf.fuzz.js`);
  process.exit(1);
}
console.log(`\nPASS — ${ITER} cases in ${elapsed}s, no throws, no timeouts, no heap blowups.`);
