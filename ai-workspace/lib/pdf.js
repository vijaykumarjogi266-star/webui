// Dependency-free PDF text extractor.
// Parses indirect objects, walks the /Pages tree for page order, resolves each
// page's /Contents stream(s), inflates FlateDecode, and pulls text-show operators.
// Covers the common case (native-text PDFs). Scanned/image-only PDFs report
// ocrNeeded=true — the production plan routes those to Tesseract (build plan §16.3).
'use strict';
const zlib = require('zlib');

// Decompression-bomb guard. A PDF stream is attacker-controlled: ~80 KB of
// FlateDecode can inflate to 80 MB+, sailing past the upload size check and
// exhausting heap (the whole store is in memory). Cap every inflate, and cap
// the total inflated bytes per document.
const MAX_STREAM_INFLATED = 8 * 1024 * 1024;   // per content stream
const MAX_DOC_INFLATED = 64 * 1024 * 1024;     // per PDF, across all streams

function extractPdf(buf) {
  const src = buf.toString('latin1');
  let inflatedTotal = 0;
  if (!src.startsWith('%PDF')) return { ok: false, error: 'Not a PDF file', pages: [] };

  // 1) collect indirect objects
  const objects = new Map(); // num -> body string
  const objRe = /(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g;
  let m;
  while ((m = objRe.exec(src)) !== null) objects.set(+m[1], m[2]);

  // 2) stream bytes for an object body
  function streamBytes(body) {
    const si = body.search(/stream\r?\n|stream\r/);
    if (si === -1) return null;
    let start = si + body.slice(si).match(/stream\r?\n|stream\r/)[0].length;
    let end = body.indexOf('endstream', start);
    if (end === -1) end = body.length;
    let raw = body.slice(start, end);
    if (raw.endsWith('\n')) raw = raw.slice(0, -1);
    const bytes = Buffer.from(raw, 'latin1');
    if (/\/FlateDecode/.test(body.slice(0, si))) {
      if (inflatedTotal >= MAX_DOC_INFLATED) return null;
      const budget = Math.min(MAX_STREAM_INFLATED, MAX_DOC_INFLATED - inflatedTotal);
      // maxOutputLength makes zlib abort instead of allocating an 80 MB buffer.
      const opts = { maxOutputLength: budget };
      let out = null;
      try { out = zlib.inflateSync(bytes, opts); }
      catch { try { out = zlib.inflateRawSync(bytes, opts); } catch { return null; } }
      if (out) inflatedTotal += out.length;
      return out;
    }
    if (bytes.length > MAX_STREAM_INFLATED) return null;
    return bytes;
  }

  // 3) find page objects and order them via the /Pages tree
  const pageNums = [];
  for (const [num, body] of objects) {
    if (/\/Type\s*\/Page(?!s)/.test(body)) pageNums.push(num);
  }
  const pageSet = new Set(pageNums);
  function kidsOf(body) {
    const km = body.match(/\/Kids\s*\[([^\]]*)\]/);
    if (!km) return [];
    const refs = [...km[1].matchAll(/(\d+)\s+\d+\s+R/g)].map(x => +x[1]);
    return refs;
  }
  const ordered = [];
  const seen = new Set();
  function walk(num) {
    if (seen.has(num)) return;
    seen.add(num);
    const body = objects.get(num);
    if (!body) return;
    if (pageSet.has(num)) { ordered.push(num); return; }
    if (/\/Type\s*\/Pages/.test(body)) for (const k of kidsOf(body)) walk(k);
  }
  for (const [num, body] of objects) {
    if (/\/Type\s*\/Pages/.test(body) && /\/Parent\b/.test(body) === false) { walk(num); break; }
  }
  if (ordered.length === 0) for (const [num, body] of objects) { if (/\/Type\s*\/Pages/.test(body)) { walk(num); if (ordered.length) break; } }
  for (const n of pageNums.sort((a, b) => a - b)) if (!seen.has(n)) ordered.push(n);

  // 4) extract text from one content stream
  function decodeString(s) {
    return s
      .replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] || c))
      .replace(/\\(\d{1,3})/g, (_, o) => { try { return String.fromCharCode(parseInt(o, 8)); } catch { return ''; } });
  }
  function textFromContent(content) {
    const str = content.toString('latin1');
    const out = [];
    const btRe = /BT([\s\S]*?)ET/g;
    let bm;
    while ((bm = btRe.exec(str)) !== null) {
      const block = bm[1];
      const parts = [];
      const opRe = /(\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*(?:Tj|')|(\(((?:\\.|[^\\()])*)\)\s*"))/g;
      let om;
      let lastY = null;
      // track Td movements to insert newlines on big vertical moves
      const posRe = /([-\d.]+)\s+([-\d.]+)\s+Td/g;
      const positions = new Map();
      let pm; let idx = 0;
      while ((pm = posRe.exec(block)) !== null) { positions.set(pm.index, parseFloat(pm[2])); }
      while ((om = opRe.exec(block)) !== null) {
        // newline heuristic: Td with sizeable negative or positive y between ops
        for (const [pi, y] of positions) {
          if (pi < om.index && (lastY === null || Math.abs(y - lastY) > 2)) { if (parts.length) parts.push('\n'); lastY = y; positions.delete(pi); }
        }
        if (om[2] !== undefined) {
          const inner = om[2];
          const pieceRe = /\(((?:\\.|[^\\()])*)\)/g; let q;
          while ((q = pieceRe.exec(inner)) !== null) parts.push(decodeString(q[1]));
        } else if (om[3] !== undefined) {
          parts.push(decodeString(om[3]));
        } else if (om[5] !== undefined) {
          parts.push(decodeString(om[5]));
        }
      }
      const line = parts.join('').replace(/[ \t]+\n/g, '\n');
      if (line.trim()) out.push(line);
    }
    return out.join('\n');
  }

  // 5) assemble pages
  const pages = [];
  for (const num of ordered) {
    const body = objects.get(num) || '';
    let refs = [];
    const cm = body.match(/\/Contents\s*\[([^\]]*)\]/);
    const cs = body.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (cm) refs = [...cm[1].matchAll(/(\d+)\s+\d+\s+R/g)].map(x => +x[1]);
    else if (cs) refs = [+cs[1]];
    let text = '';
    for (const r of refs) {
      const ob = objects.get(r);
      if (!ob) continue;
      const bytes = streamBytes(ob);
      if (bytes) text += textFromContent(bytes) + '\n';
    }
    pages.push({ page: pages.length + 1, text: text.replace(/\n{3,}/g, '\n\n').trim() });
  }

  const totalChars = pages.reduce((a, p) => a + p.text.length, 0);
  if (pages.length === 0) return { ok: false, error: 'Could not locate page objects', pages: [], ocrNeeded: true };
  if (totalChars < 50) return { ok: false, error: 'No extractable text — likely a scanned PDF. OCR pipeline ships in the production build (plan §16.3).', pages, ocrNeeded: true };
  return { ok: true, pages };
}

module.exports = { extractPdf };
