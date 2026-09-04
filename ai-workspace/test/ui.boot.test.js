// Boot test for the extracted front-end bundles.
// After splitting the inline <script> into /index.js and /atelier.js (V33, to
// drop 'unsafe-inline' from the CSP), a top-level error would leave users with a
// blank page that no server-side test would catch. This evaluates each bundle
// against a stub DOM and asserts it runs to completion and gates on auth first.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');

function runBundle(file) {
  const js = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const calls = { listeners: [], fetches: [] };
  const calls2 = null;

function makeEl() {
  const el = {
    style:{}, dataset:{}, classList:{ add(){}, remove(){}, toggle(){}, contains(){return false} },
    children:[], value:'', textContent:'', innerHTML:'',
    appendChild(c){ this.children.push(c); return c; },
    querySelector(){ return makeEl(); }, querySelectorAll(){ return []; },
    addEventListener(){}, removeEventListener(){}, closest(){ return null; },
    setAttribute(){}, getAttribute(){ return null; }, remove(){}, focus(){}, click(){},
    insertAdjacentHTML(){}, scrollTo(){}, scrollIntoView(){},
  };
  return new Proxy(el, { get:(t,k)=> k in t ? t[k] : (typeof k==='string' ? undefined : undefined),
                         set:(t,k,v)=>{ t[k]=v; return true; } });
}
const doc = {
  readyState:'complete',
  documentElement: makeEl(), body: makeEl(), head: makeEl(),
  getElementById(){ return makeEl(); },
  querySelector(){ return makeEl(); }, querySelectorAll(){ return []; },
  createElement(){ return makeEl(); },
  addEventListener(t){ calls.listeners.push(t); },
};
const store = () => { const m={}; return { getItem:k=>k in m?m[k]:null, setItem:(k,v)=>{m[k]=String(v)}, removeItem:k=>{delete m[k]}, clear(){}, key:()=>null, length:0 }; };

const sandbox = {
  document: doc, console,
  localStorage: store(), sessionStorage: store(),
  location:{ href:'http://localhost:3000/', origin:'http://localhost:3000', reload(){} },
  navigator:{ clipboard:{ writeText:async()=>{} }, userAgent:'test' },
  fetch: async (u) => { calls.fetches.push(String(u));
    return { ok:true, status:200, headers:new Map(),
             json:async()=>({ authRequired:true, authenticated:false, credentials:[], conversations:[], files:[], repos:[] }),
             text:async()=>'' }; },
  setTimeout, clearTimeout, setInterval, clearInterval,
  AbortController, FileReader: function(){ this.readAsDataURL=()=>{}; },
  requestAnimationFrame: (f)=>setTimeout(f,0),
  alert(){}, confirm(){return true}, matchMedia:()=>({matches:false, addEventListener(){}}),
  EventSource: function(){ this.addEventListener=()=>{}; this.close=()=>{}; },
  crypto: require('crypto').webcrypto, URL, Blob: class {}, FormData: class {},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;


  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: file, timeout: 10000 });
  return calls;
}

for (const file of ['index.js', 'atelier.js']) {
  test(`${file} executes to completion and gates on /api/auth/status`, async () => {
    let calls;
    assert.doesNotThrow(() => { calls = runBundle(file); }, `${file} threw at top level`);
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(calls.listeners.length > 0, 'no document listeners registered');
    assert.ok(calls.fetches.some((u) => String(u).includes('/api/auth/status')),
      `${file} did not check the auth gate on boot (fetches: ${JSON.stringify(calls.fetches)})`);
  });
}

test('no inline event handlers or inline <script> remain in the served HTML/JS', () => {
  for (const f of ['index.html', 'atelier.html', 'hub.html', 'index.js', 'atelier.js', 'hub.js']) {
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    assert.ok(!/\son\w+\s*=\s*["']/.test(src), `${f} still contains an inline event handler`);
  }
  for (const f of ['index.html', 'atelier.html', 'hub.html']) {
    const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    if (f !== 'hub.html') assert.ok(!/<style>/.test(src), `${f} still contains an inline <style> block`);
    assert.ok(!/<script>/.test(src), `${f} still contains an inline <script> block`);
  }
});

test('hub.html links resolve: docs on disk, live links to served paths', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'hub.html'), 'utf8');
  const hrefs = [...src.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    .filter((h) => !/^https?:/.test(h));
  assert.ok(hrefs.length > 0, 'no relative links found');

  for (const h of hrefs) {
    const clean = h.split('#')[0];
    if (clean.startsWith('/')) {
      // Root-absolute: a path the SERVER exposes. Either a real file in public/
      // or an API route — never a filesystem path relative to the page.
      const asFile = path.join(PUBLIC, clean);
      const isApi = clean.startsWith('/api/');
      assert.ok(isApi || fs.existsSync(asFile), `hub.html live link is not served: ${h}`);
    } else {
      // Relative: resolved from disk when the page is opened via file://.
      assert.ok(fs.existsSync(path.resolve(PUBLIC, clean)), `hub.html links to a missing file: ${h}`);
    }
  }
});
