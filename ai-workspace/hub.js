// Hub page behaviour. External file (not inline) so this page stays compatible
// with the app's strict CSP if it is ever served rather than opened via file://.
'use strict';

/* ---------- theme ---------- */
const themeBtn = document.getElementById('theme');
function applyTheme() {
  let dark = false;
  try { dark = localStorage.getItem('hubTheme') === 'dark'; } catch { /* file:// may deny storage */ }
  document.documentElement.classList.toggle('dark', dark);
  themeBtn.textContent = dark ? 'Light mode' : 'Dark mode';
}
themeBtn.addEventListener('click', () => {
  const now = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
  try { localStorage.setItem('hubTheme', now); } catch {}
  applyTheme();
});
applyTheme();

/* ---------- API table ---------- */
const ROUTES = [
  ['/api/health/live', 'GET', 'public', 'Liveness probe'],
  ['/api/health/ready', 'GET', 'public', 'Readiness + counters'],
  ['/api/auth/status', 'GET', 'public', 'Is a token required, am I signed in'],
  ['/api/auth/login', 'POST', 'public', 'Exchange the token for a session cookie'],
  ['/api/bootstrap', 'GET', 'token', 'Everything the UI needs on load'],
  ['/api/credentials', 'GET · POST', 'token', 'List / add a provider key (stored encrypted)'],
  ['/api/credentials/:id/test', 'POST', 'token', 'Verify a key against the provider'],
  ['/api/models?cred=:id', 'GET', 'token', 'Model catalogue with vision and pricing'],
  ['/api/conversations', 'GET · POST', 'token', 'List / create a conversation'],
  ['/api/chat/stream', 'POST', 'token', 'SSE streaming completion'],
  ['/api/files', 'GET · POST', 'token', 'List / upload a document for RAG'],
  ['/api/github', 'GET · POST', 'token', 'Index a public repository'],
  ['/api/feedback', 'GET · POST', 'token', 'Submit and triage feedback'],
  ['/api/usage', 'GET', 'token', 'Token and cost totals'],
];
document.getElementById('api').innerHTML = ROUTES.map(([p, m, a, d]) => `
  <tr>
    <td class="num">${p}</td>
    <td>${m}</td>
    <td><span class="badge ${a === 'public' ? 'green' : 'amber'}">${a}</span></td>
    <td>${d}</td>
  </tr>`).join('');

/* ---------- live status ---------- */
const $ = (id) => document.getElementById(id);
const originInput = $('origin');

function setOriginLinks(origin) {
  document.querySelectorAll('a.card.live').forEach((a) => {
    a.href = origin.replace(/\/+$/, '') + a.dataset.path;
  });
}

function paint(state, detail) {
  const dot = $('dot'), title = $('st-title'), badge = $('st-badge');
  const kv = $('kv'), hint = $('hint'), liveNote = $('live-note');

  dot.className = 'dot ' + (state === 'up' ? 'on' : state === 'down' ? 'off' : 'wait');
  badge.className = 'badge ' + (state === 'up' ? 'green' : state === 'down' ? 'red' : 'amber');

  if (state === 'up') {
    title.textContent = 'Server is running';
    badge.textContent = 'online';
    kv.hidden = false;
    hint.hidden = true;
    liveNote.className = 'badge green';
    liveNote.textContent = 'online';
    $('k-health').textContent = 'ok';
    $('k-up').textContent = detail.uptime != null ? Math.round(detail.uptime) + 's' : '—';
    if (detail.auth) {
      const a = detail.auth;
      $('k-auth').innerHTML = a.authRequired
        ? (a.authenticated
            ? '<span class="badge green">signed in</span>'
            : '<span class="badge amber">token required</span> — paste it in the app to sign in')
        : '<span class="badge red">disabled</span> — AUTH_DISABLED is set';
    } else {
      $('k-auth').textContent = '—';
    }
  } else if (state === 'down') {
    title.textContent = 'No server responding';
    badge.textContent = 'offline';
    kv.hidden = true;
    hint.hidden = false;
    liveNote.className = 'badge';
    liveNote.textContent = 'needs a running server';
  } else {
    title.textContent = 'Checking for a running server…';
    badge.textContent = 'probing';
  }
}

async function probe() {
  const origin = (originInput.value || '').trim().replace(/\/+$/, '') || 'http://localhost:3000';
  setOriginLinks(origin);
  paint('probing');
  try {
    const live = await fetch(origin + '/api/health/live', { signal: AbortSignal.timeout(2500) });
    if (!live.ok) throw new Error('unhealthy');
    const health = await live.json();
    let auth = null;
    try {
      auth = await (await fetch(origin + '/api/auth/status', {
        credentials: 'include', signal: AbortSignal.timeout(2500),
      })).json();
    } catch { /* older build, or blocked cross-origin; health alone is enough */ }
    paint('up', { uptime: health.uptime, auth });
  } catch {
    // Opened via file://, a cross-origin fetch to localhost can be blocked by the
    // browser even when the server IS up. Say so rather than claiming it is down.
    paint('down');
  }
}

$('recheck').addEventListener('click', probe);
originInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') probe(); });
probe();
