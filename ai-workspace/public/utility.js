'use strict';
var $ = function (id) { return document.getElementById(id); };

/* theme */
function theme() {
  var d = false; try { d = localStorage.getItem('uTheme') === 'dark'; } catch (e) {}
  document.documentElement.classList.toggle('dark', d);
  $('theme').textContent = d ? 'Light' : 'Dark';
}
$('theme').onclick = function () {
  var n = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
  try { localStorage.setItem('uTheme', n); } catch (e) {} theme();
};
theme();

/* origin */
var DEF = location.protocol === 'file:' ? 'http://localhost:3000' : location.origin;
$('origin').value = DEF;
function base() { return ($('origin').value || DEF).trim().replace(/\/+$/, ''); }

/* Docs live outside the served root. Relative paths work from file://; over
   HTTP they would 404, so point at GitHub instead. Demo links get the same
   treatment since demo-*.html are not served either. */
var REPO = 'https://github.com/vijaykumarjogi266-star/webui/blob/master/ai-workspace/';
if (location.protocol !== 'file:') {
  Array.prototype.forEach.call(document.querySelectorAll('a[data-doc]'), function (a) {
    var rel = a.dataset.doc;
    a.href = rel.indexOf('../') === 0
      ? REPO.replace('/ai-workspace/', '/') + rel.slice(3)
      : REPO + rel;
    a.target = '_blank'; a.rel = 'noopener';
  });
}

/* links */
var LINKS = [
  ['/', 'Chat UI', 'Main workspace — chat, RAG, repos'],
  ['/atelier.html', 'Atelier UI', 'Alternate layout, same API'],
  ['/hub.html', 'Hub page', 'Served launcher (needs server)'],
  ['/api/health/ready', 'Readiness', 'JSON counters, no token']
];
function demoTile(file, label) {
  var served = location.protocol !== 'file:';
  var href = served ? REPO + file : file;
  var note = served ? 'Single-file demo — opens on GitHub' : 'Mock backend, no server needed';
  return '<a class="tile"' + (served ? ' target="_blank" rel="noopener"' : '') + ' href="' + href + '">' +
    '<div class="t">' + label + ' <span class="badge green">offline</span></div><div class="d">' + note + '</div></a>';
}
function paintLinks() {
  $('links').innerHTML = LINKS.map(function (l) {
    return '<a class="tile" target="_blank" rel="noopener" href="' + base() + l[0] + '">' +
      '<div class="t">' + l[1] + '</div><div class="d">' + l[2] + '</div></a>';
  }).join('') +
  demoTile('demo-ui.html', 'Chat demo') + demoTile('demo-atelier.html', 'Atelier demo');
}

/* routes table */
var R = [
  ['GET /api/health/live', 0, 'Liveness'], ['GET /api/health/ready', 0, 'Readiness + counters'],
  ['GET /api/auth/status', 0, 'Token required? signed in?'], ['POST /api/auth/login', 0, 'Token → session cookie'],
  ['GET /api/bootstrap', 1, 'Everything the UI loads'], ['GET·POST /api/credentials', 1, 'Provider keys (encrypted)'],
  ['GET /api/models?cred=:id', 1, 'Model catalogue'], ['GET·POST /api/conversations', 1, 'Conversations'],
  ['POST /api/chat/stream', 1, 'SSE streaming completion'], ['GET·POST /api/files', 1, 'Documents for RAG'],
  ['GET·POST /api/github', 1, 'Index a public repo'], ['GET·POST /api/feedback', 1, 'Feedback + triage'],
  ['GET /api/usage', 1, 'Token and cost totals']
];
$('routes').innerHTML = R.map(function (r) {
  return '<tr><td class="m">' + r[0] + '</td><td><span class="badge ' + (r[1] ? 'amber">token' : 'green">public') +
    '</span></td><td>' + r[2] + '</td></tr>';
}).join('');

/* status */
function setAuth(a) {
  var b = $('authb');
  if (!a) { b.className = 'badge'; b.textContent = 'unknown'; return; }
  if (!a.authRequired) { b.className = 'badge red'; b.textContent = 'auth disabled'; }
  else if (a.authenticated) { b.className = 'badge green'; b.textContent = 'signed in'; }
  else { b.className = 'badge amber'; b.textContent = 'token required'; }
}
function probe() {
  paintLinks();
  $('dot').className = 'dot wait'; $('stat').textContent = 'Checking…';
  $('statb').className = 'badge'; $('statb').textContent = 'probing';
  fetch(base() + '/api/health/live', { signal: AbortSignal.timeout(2500) })
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (h) {
      $('dot').className = 'dot on'; $('stat').textContent = 'Server is running';
      $('statb').className = 'badge green'; $('statb').textContent = 'online';
      $('info').textContent = 'uptime ' + Math.round(h.uptime || 0) + 's';
      return fetch(base() + '/api/auth/status', { credentials: 'include' }).then(function (r) { return r.json(); });
    })
    .then(setAuth)
    .catch(function () {
      $('dot').className = 'dot off'; $('stat').textContent = 'No server responding';
      $('statb').className = 'badge red'; $('statb').textContent = 'offline';
      $('info').innerHTML = 'Start it with <code>cd ai-workspace &amp;&amp; node server.js</code>';
      setAuth(null);
    });
}
$('check').onclick = probe;
$('origin').onkeydown = function (e) { if (e.key === 'Enter') probe(); };

/* auth */
$('login').onclick = function () {
  fetch(base() + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    credentials: 'include', body: JSON.stringify({ token: $('token').value })
  }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (x) {
      $('out').textContent = JSON.stringify(x.j, null, 2);
      if (x.s === 200) { $('token').value = ''; probe(); }
      else { $('authb').className = 'badge red'; $('authb').textContent = 'rejected'; }
    }).catch(function (e) { $('out').textContent = 'Request failed: ' + e.message; });
};
$('logout').onclick = function () {
  fetch(base() + '/api/auth/logout', { method: 'POST', credentials: 'include' }).then(probe).catch(function () {});
};

/* api tester */
function send(m, p, b) {
  $('rstat').className = 'badge'; $('rstat').textContent = '…';
  var o = { method: m, credentials: 'include', headers: {} };
  if (m !== 'GET' && b && b.trim()) { o.headers['content-type'] = 'application/json'; o.body = b; }
  var t = Date.now();
  fetch(base() + p, o).then(function (r) {
    return r.text().then(function (txt) {
      var ms = Date.now() - t;
      $('rstat').className = 'badge ' + (r.ok ? 'green' : r.status === 401 || r.status === 403 ? 'amber' : 'red');
      $('rstat').textContent = r.status + ' · ' + ms + 'ms';
      try { $('out').textContent = JSON.stringify(JSON.parse(txt), null, 2); }
      catch (e) { $('out').textContent = txt.slice(0, 4000) || '(empty)'; }
    });
  }).catch(function (e) {
    $('rstat').className = 'badge red'; $('rstat').textContent = 'failed';
    $('out').textContent = 'Request failed: ' + e.message + '\n\nIs the server running? Is the origin right?';
  });
}
$('send').onclick = function () { send($('m').value, $('path').value, $('body').value); };
Array.prototype.forEach.call(document.querySelectorAll('.q'), function (b) {
  b.onclick = function () { $('m').value = b.dataset.m; $('path').value = b.dataset.p; send(b.dataset.m, b.dataset.p, ''); };
});

/* base64 */
var payload = null;
$('file').onchange = function (e) {
  var f = e.target.files[0]; if (!f) return;
  var r = new FileReader();
  r.onload = function () {
    var b64 = String(r.result).split(',')[1] || '';
    payload = { name: f.name, dataBase64: b64 };
    $('fb').className = 'badge green';
    $('fb').textContent = f.name + ' · ' + (f.size / 1024).toFixed(0) + ' KB';
    $('b64').textContent = JSON.stringify({ name: f.name, dataBase64: b64.slice(0, 180) + '…' }, null, 2);
  };
  r.readAsDataURL(f);
};
$('copy').onclick = function () {
  if (!payload) return;
  navigator.clipboard.writeText(JSON.stringify(payload)).then(function () {
    $('fb').textContent = 'copied to clipboard';
  }).catch(function () { $('fb').textContent = 'copy blocked'; });
};
$('up').onclick = function () {
  if (!payload) { $('out').textContent = 'Pick a file first.'; return; }
  send('POST', '/api/files', JSON.stringify(payload));
};

probe();


