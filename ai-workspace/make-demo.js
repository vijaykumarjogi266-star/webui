// Generates demo-ui.html: the real UI with an injected mock backend (no server needed).
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const SHIM = `
/* ================= storage guards (sandboxed iframes deny localStorage) ================= */
(function () {
  function memStorage() {
    const store = {};
    return {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear: () => { for (const k in store) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: (i) => Object.keys(store)[i] || null,
    };
  }
  try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); }
  catch { Object.defineProperty(window, 'localStorage', { value: memStorage(), configurable: true }); }
  try { sessionStorage.setItem('__t', '1'); sessionStorage.removeItem('__t'); }
  catch { Object.defineProperty(window, 'sessionStorage', { value: memStorage(), configurable: true }); }
})();
/* ================= OFFLINE DEMO SHIM — mock backend, injected for demo-ui.html ================= */
(function () {
  const now = new Date().toISOString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try { if (localStorage.getItem('selCred') !== 'demo-cred') { localStorage.removeItem('selCred'); localStorage.removeItem('selModel'); } } catch {}

  const CRED = { id: 'demo-cred', provider: 'openrouter', displayName: null, baseUrl: null, masked: 'sk-or-\\u2026demo', status: 'connected', lastTestedAt: now, lastError: null };
  const MODELS = [
    { id: 'demo/meridian-chat', name: 'Meridian Chat (demo)', vision: false, context: 128000, inputCostPerMtok: 0.15, outputCostPerMtok: 0.6, source: 'provider' },
    { id: 'demo/vision-pro', name: 'Vision Pro (demo)', vision: true, context: 128000, inputCostPerMtok: 2.5, outputCostPerMtok: 10, source: 'provider' },
    { id: 'demo/flash-free:free', name: 'Flash Free (demo)', vision: false, context: 32000, inputCostPerMtok: 0, outputCostPerMtok: 0, source: 'provider' },
  ];
  let convSeq = 3;
  const CONVOS = [
    { id: 'c1', title: 'Meridian Q3 report Q&A', updatedAt: now, model: 'demo/meridian-chat' },
    { id: 'c2', title: 'Office policy questions', updatedAt: now, model: 'demo/flash-free:free' },
  ];
  const MSGS = {
    c1: [
      { id: 'm1', role: 'user', content: 'How much did Meridian revenue grow in Q3?', fileIds: ['f1'], repoIds: [], images: [], at: now },
      { id: 'm2', role: 'assistant', model: 'demo/meridian-chat', status: 'complete', inputTokens: 412, outputTokens: 88,
        content: 'Meridian\\u2019s revenue grew **23 percent** in Q3, reaching \\u20b94.2 crore.\\n\\nKey points from the report:\\n- Growth is driven by the Mumbai region expansion\\n- The same document approves the hiring plan (see page 2)\\n\\n\`\`\`text\\nQ3 revenue: \\u20b94.2 crore  (+23% QoQ)\\n\`\`\`',
        citations: [{ source: 'meridian-q3.pdf', page: 1, type: 'file' }], at: now },
      { id: 'm3', role: 'user', content: 'What does the hiring plan say?', fileIds: ['f1'], repoIds: [], images: [], at: now },
      { id: 'm4', role: 'assistant', model: 'demo/meridian-chat', status: 'complete', inputTokens: 655, outputTokens: 61,
        content: 'The hiring plan approves **12 new engineers in Chennai** [meridian-q3.pdf \\u00b7 p.2]. The document does not specify start dates or compensation bands \\u2014 for anything beyond that, I could not find this in the uploaded document.',
        citations: [{ source: 'meridian-q3.pdf', page: 2, type: 'file' }], at: now },
    ],
    c2: [
      { id: 'm5', role: 'user', content: 'How many remote days are allowed?', fileIds: ['f2'], repoIds: [], images: [], at: now },
      { id: 'm6', role: 'assistant', model: 'demo/flash-free:free', status: 'complete', inputTokens: 240, outputTokens: 45,
        content: 'Remote work is allowed **two days per week**, and there is a laptop stipend of \\u20b960,000 per year [notes.md \\u00b7 p.1].',
        citations: [{ source: 'notes.md', page: 1, type: 'file' }], at: now },
    ],
  };
  let FILES = [
    { id: 'f1', name: 'meridian-q3.pdf', kind: 'pdf', byteSize: 742, indexStatus: 'ready', chunks: 2, pages: 2, error: null, extraction: 'native', at: now },
    { id: 'f2', name: 'notes.md', kind: 'text', byteSize: 163, indexStatus: 'ready', chunks: 1, pages: 1, error: null, extraction: 'native', at: now },
    { id: 'f3', name: 'policy.csv', kind: 'text', byteSize: 38, indexStatus: 'ready', chunks: 1, pages: 1, error: null, extraction: 'native', at: now },
  ];
  let REPOS = [{ id: 'r1', owner: 'octocat', repo: 'Hello-World', defaultBranch: 'master', description: 'My first repository on GitHub! (demo)', status: 'ready', filesIndexed: 1, filesSkipped: 0, skippedReasons: [], headSha: '7fd1a60', chunkCount: 1, fileList: ['README'], at: now }];
  const REPO_FILES = { r1: { README: 'Hello World!\\n' } };
  let FEEDBACK = [
    { id: 'fb1', type: 'bug', priority: 'high', status: 'triaged', title: 'Model list slow to load on mobile', description: 'The model dropdown takes a few seconds on a phone connection.', pageUrl: '/chat', consent: true, browser: 'demo-browser', history: [{ status: 'new', at: now, by: 'system' }, { status: 'triaged', at: now, by: 'admin' }], createdAt: now },
    { id: 'fb2', type: 'feature_request', priority: 'medium', status: 'new', title: 'Export conversations to Markdown', description: 'Would love a one-click export for sharing answers with my team.', pageUrl: '/chat', consent: false, browser: null, history: [{ status: 'new', at: now, by: 'system' }], createdAt: now },
  ];
  const USAGE = {
    totals: { calls: 14, input: 6210, output: 1180, cost: 0.0041 },
    perConversation: [
      { id: 'c1', title: 'Meridian Q3 report Q&A', calls: 9, input: 4980, output: 940, cost: 0.0035, models: ['demo/meridian-chat'] },
      { id: 'c2', title: 'Office policy questions', calls: 5, input: 1230, output: 240, cost: 0.0006, models: ['demo/flash-free:free'] },
    ],
  };

  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const body = async (opts) => { try { return JSON.parse(opts && opts.body || '{}'); } catch { return {}; } };

  function buildReply(payload) {
    if ((payload.repoIds || []).length) {
      return 'Looking at the connected repository, the **README** declares the project intent:\\n\\n\`\`\`text\\nHello World!\\n\`\`\`\\n\\nThis is a mock offline demo \\u2014 with a live server and real key, the answer is grounded in the indexed files and cites exact paths.';
    }
    if ((payload.fileIds || []).length) {
      const names = payload.fileIds.map((id) => (FILES.find((f) => f.id === id) || {}).name || 'file');
      return 'Based on **' + names[0] + '**: Meridian\\u2019s revenue grew **23 percent** to \\u20b94.2 crore in Q3, and the hiring plan approves 12 new engineers in Chennai.\\n\\n> Mock demo answer \\u2014 the live build retrieves real chunks with BM25 and cites the exact pages.';
    }
    return 'This is the **offline UI demo** running on mock data \\u2014 no server, no API key.\\n\\nEverything you see is interactive:\\n- Streaming responses (simulated token-by-token)\\n- Attach files or repos with **\\uff0b Attach** and see citations\\n- Attach an image to a text-only model to see the vision gate\\n- Try **Stop** mid-stream, triage feedback, check Usage\\n\\nFor the real thing, run "node server.js" in the project.';
  }

  window.fetch = async function (url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const path = String(url).replace(/^https?:\\/\\/[^/]+/, '');
    await sleep(50);

    if (path === '/api/bootstrap') return json(200, { credentials: [CRED], conversations: CONVOS, files: FILES, repos: REPOS, feedbackCount: FEEDBACK.length, systemPromptDefault: '' });
    if (path === '/api/health/live') return json(200, { ok: true });
    if (path === '/api/credentials' && method === 'GET') return json(200, { credentials: [CRED] });
    if (/^\\/api\\/credentials\\/demo-cred\\/test$/.test(path)) return json(200, { status: 'connected', modelCount: MODELS.length });
    if (/^\\/api\\/credentials\\/demo-cred\\/rotate$/.test(path)) return json(200, { credential: { ...CRED, status: 'not_tested' } });
    if (/^\\/api\\/credentials\\//.test(path) && method === 'DELETE') return json(200, { ok: true });
    if (path.startsWith('/api/models?cred=')) return json(200, { provider: 'openrouter', models: MODELS });
    if (path === '/api/models/refresh') return json(200, { count: MODELS.length });

    if (path === '/api/conversations' && method === 'GET') return json(200, { conversations: CONVOS });
    if (path === '/api/conversations' && method === 'POST') {
      const c = { id: 'c' + (convSeq++), title: 'New chat', createdAt: now, updatedAt: now };
      CONVOS.unshift(c); MSGS[c.id] = [];
      return json(201, { conversation: c });
    }
    let m = path.match(/^\\/api\\/conversations\\/([\\w-]+)$/);
    if (m && method === 'GET') {
      const c = CONVOS.find((x) => x.id === m[1]);
      return c ? json(200, { conversation: c, messages: MSGS[c.id] || [] }) : json(404, { error: { message: 'Conversation not found' } });
    }
    if (m && method === 'DELETE') {
      const i = CONVOS.findIndex((x) => x.id === m[1]); if (i >= 0) CONVOS.splice(i, 1); delete MSGS[m[1]];
      return json(200, { ok: true });
    }

    if (path === '/api/chat/stream' && method === 'POST') {
      const payload = await body(opts);
      const info = MODELS.find((x) => x.id === payload.model);
      if ((payload.images || []).length && info && info.vision === false) {
        return json(400, { error: { code: 'vision_unsupported', message: 'This model cannot view images. Choose a vision-capable model \\u2014 the list is filterable in the selector.' } });
      }
      const cites = (payload.fileIds || []).map((id) => { const f = FILES.find((x) => x.id === id); return f ? { source: f.name, page: 1, type: 'file' } : null; }).filter(Boolean)
        .concat((payload.repoIds || []).map(() => ({ source: 'octocat/Hello-World', page: 'README', type: 'repo' })));
      const text = buildReply(payload);
      const convo = CONVOS.find((x) => x.id === payload.conversationId);
      if (convo && convo.title === 'New chat') convo.title = payload.message.slice(0, 60);
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (ev, data) => controller.enqueue(enc.encode('event: ' + ev + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'));
          send('start', { conversationId: payload.conversationId, model: payload.model, evidenceCount: cites.length, citations: cites });
          const words = text.split(/(\\s+)/);
          let acc = '';
          for (let i = 0; i < words.length; i += 6) {
            if (opts.signal && opts.signal.aborted) break;
            const piece = words.slice(i, i + 6).join('');
            acc += piece;
            send('delta', { text: piece });
            await sleep(18);
          }
          const msgs = MSGS[payload.conversationId] || (MSGS[payload.conversationId] = []);
          msgs.push({ id: 'u' + Date.now(), role: 'user', content: payload.message, fileIds: payload.fileIds || [], repoIds: payload.repoIds || [], images: (payload.images || []).map((x) => x.name), at: new Date().toISOString() });
          msgs.push({ id: 'a' + Date.now(), role: 'assistant', content: acc, model: payload.model, status: 'complete', inputTokens: 380, outputTokens: Math.max(20, Math.round(acc.length / 4)), citations: cites, at: new Date().toISOString() });
          send('usage', { input: 380, output: Math.max(20, Math.round(acc.length / 4)), estimated: false, cost: 0.00031, finishReason: 'stop' });
          send('done', { ok: true, stopped: false });
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }

    if (path === '/api/files' && method === 'GET') return json(200, { files: FILES });
    if (path === '/api/files' && method === 'POST') {
      const b = await body(opts);
      if (/\\.exe$/i.test(b.name || '')) return json(400, { error: { message: 'Unsupported file type ".exe". Supported: PDF, TXT, MD, CSV, JSON, and common code files.' } });
      const f = { id: 'f' + Date.now(), name: b.name, kind: /\\.pdf$/i.test(b.name) ? 'pdf' : 'text', byteSize: 1024, indexStatus: 'ready', chunks: 2, pages: /\\.pdf$/i.test(b.name) ? 2 : 1, error: null, extraction: 'native', at: new Date().toISOString() };
      FILES.push(f);
      return json(201, { file: f });
    }
    m = path.match(/^\\/api\\/files\\/([\\w-]+)$/);
    if (m && method === 'DELETE') { FILES = FILES.filter((f) => f.id !== m[1]); return json(200, { ok: true }); }

    if (path === '/api/github' && method === 'GET') return json(200, { repos: REPOS });
    if (path === '/api/github' && method === 'POST') {
      const b = await body(opts);
      const r = { id: 'r' + Date.now(), owner: b.owner || 'demo', repo: b.repo || 'repo', defaultBranch: 'main', description: 'Demo index (mock)', status: 'ready', filesIndexed: 3, filesSkipped: 1, skippedReasons: ['possible secret: .env'], chunkCount: 4, fileList: ['README.md', 'src/index.js', 'src/utils.js'], at: new Date().toISOString() };
      REPO_FILES[r.id] = { 'README.md': '# ' + r.repo + '\\n\\nDemo readme.\\n', 'src/index.js': 'console.log("hello from ' + r.repo + '");\\n', 'src/utils.js': 'export const add = (a, b) => a + b;\\n' };
      REPOS.push(r);
      return json(201, { repo: r });
    }
    m = path.match(/^\\/api\\/github\\/([\\w-]+)\\/file\\?path=(.+)$/);
    if (m) {
      const files = REPO_FILES[m[1]] || {};
      const p = decodeURIComponent(m[2]);
      return (p in files) ? json(200, { path: p, content: files[p] }) : json(404, { error: { message: 'File not in index' } });
    }
    m = path.match(/^\\/api\\/github\\/([\\w-]+)$/);
    if (m && method === 'DELETE') { REPOS = REPOS.filter((r) => r.id !== m[1]); delete REPO_FILES[m[1]]; return json(200, { ok: true }); }

    if (path === '/api/feedback' && method === 'GET') return json(200, { feedback: [...FEEDBACK].reverse() });
    if (path === '/api/feedback' && method === 'POST') {
      const b = await body(opts);
      const item = { id: 'fb' + Date.now(), type: b.type, priority: b.priority || 'medium', status: 'new', title: String(b.title || '').slice(0, 200), description: String(b.description || '').slice(0, 5000), pageUrl: b.pageUrl || null, consent: !!b.consent, browser: b.consent ? (b.browser || null) : null, history: [{ status: 'new', at: new Date().toISOString(), by: 'system' }], createdAt: new Date().toISOString() };
      FEEDBACK.push(item);
      return json(201, { feedback: item, message: 'Feedback submitted. Thank you \\u2014 an admin can review it from the feedback dashboard.' });
    }
    m = path.match(/^\\/api\\/feedback\\/([\\w-]+)$/);
    if (m && method === 'PUT') {
      const b = await body(opts);
      const allowed = ['new', 'triaged', 'needs_more_information', 'planned', 'in_progress', 'resolved', 'closed', 'rejected'];
      if (!allowed.includes(b.status)) return json(400, { error: { message: 'Invalid status' } });
      const item = FEEDBACK.find((f) => f.id === m[1]);
      if (!item) return json(404, { error: { message: 'Feedback not found' } });
      item.status = b.status; item.history.push({ status: b.status, at: new Date().toISOString(), by: 'admin' });
      return json(200, { feedback: item });
    }

    if (path === '/api/usage') return json(200, USAGE);

    return json(404, { error: { message: 'Mock route not found: ' + path } });
  };

  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;top:10px;right:10px;z-index:200;background:#4f46e5;color:#fff;font-size:11px;font-weight:600;border-radius:999px;padding:4px 12px;box-shadow:0 1px 4px rgba(0,0,0,.25);pointer-events:none';
    b.textContent = 'Offline UI demo \\u2014 mock data';
    document.body.appendChild(b);
    document.title = 'AI Workspace \\u2014 Offline UI Demo';
  });
})();
/* ================= end shim ================= */
`;

const marker = "'use strict';";
function buildDemo(srcFile, outFile) {
  const html = fs.readFileSync(path.join(__dirname, srcFile), 'utf8');
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('marker not found in ' + srcFile);
  let out = html.slice(0, idx + marker.length) + '\n' + SHIM + html.slice(idx + marker.length);
  out = out.replace(/<title>[^<]*<\/title>/, '<title>AI Workspace \u2014 Offline UI Demo</title>');
  fs.writeFileSync(path.join(__dirname, outFile), out);
  console.log(outFile + ' written:', out.length, 'bytes');
}
buildDemo('public/index.html', 'demo-ui.html');
buildDemo('public/atelier.html', 'demo-atelier.html');
