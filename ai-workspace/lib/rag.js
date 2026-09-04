// Page-aware chunking + BM25 retrieval (dependency-free).
// Production plan upgrades retrieval to hybrid pgvector+FTS with reranking (§17).
'use strict';

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9_]{2,}/g)) || [];
}

function makeChunks({ sourceId, sourceType, sourceName, pages }) {
  // pages: [{page, text}] — split each page's text into ~700-char chunks on boundaries
  const TARGET = 700;
  const chunks = [];
  for (const p of pages) {
    if (!p.text || !p.text.trim()) continue;
    const paras = p.text.split(/\n{2,}/);
    let buf = '';
    const flush = () => {
      if (buf.trim()) {
        chunks.push({
          id: `${sourceId}:${chunks.length}`,
          sourceId, sourceType, sourceName,
          page: p.page,
          text: buf.trim(),
          tokens: tokenize(buf),
        });
      }
      buf = '';
    };
    for (const para of paras) {
      if ((buf + '\n\n' + para).length > TARGET && buf) { flush(); }
      // huge paragraph: hard split
      if (para.length > TARGET * 1.5) {
        flush();
        for (let i = 0; i < para.length; i += TARGET) {
          chunks.push({
            id: `${sourceId}:${chunks.length}`,
            sourceId, sourceType, sourceName,
            page: p.page,
            text: para.slice(i, i + TARGET),
            tokens: tokenize(para.slice(i, i + TARGET)),
          });
        }
        continue;
      }
      buf = buf ? buf + '\n\n' + para : para;
    }
    flush();
  }
  return chunks.slice(0, 500); // demo cap; production limit is configurable (§25 of prompt)
}

function bm25(chunks, query, k = 5) {
  const qTokens = tokenize(query);
  if (!qTokens.length || !chunks.length) return [];
  const N = chunks.length;
  const df = new Map();
  for (const c of chunks) {
    for (const t of new Set(c.tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgDl = chunks.reduce((a, c) => a + c.tokens.length, 0) / N || 1;
  const k1 = 1.5, b = 0.75;
  const scored = [];
  for (const c of chunks) {
    const tf = new Map();
    for (const t of c.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const qt of qTokens) {
      const f = tf.get(qt) || 0;
      if (!f) continue;
      const n = df.get(qt) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.tokens.length) / avgDl)));
    }
    if (score > 0) scored.push({ chunk: c, score });
  }
  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, k);
}

module.exports = { makeChunks, bm25, tokenize };
