# Security review & hardening — AI Workspace

Adversarial (ethical-hacking) review of the `ai-workspace/` build, followed by fixes.
Everything below was reproduced against a running instance before and after the patch.

**Scope:** `server.js`, `lib/{store,providers,rag,pdf}.js`, `public/{index,atelier}.html`,
`scripts/smoke.js`, `Dockerfile`, deploy layer.
**Method:** source review + live exploitation (curl) against `127.0.0.1:3000`.
**Result:** 14 findings — 5 critical, 4 high, 3 medium, 2 low. All fixed.
A **second-pass self-audit of the fixes themselves** (§5) found 7 more issues in the patch,
including a real CSRF bypass and an SSRF filter bypass. A **third pass** (§6) critiqued the
hardening for availability and correctness rather than just exploitability, and found the
brute-force limiter had turned into a self-inflicted lockout. A **fourth pass** (§7) attacked
the file parsers and found an unfixed decompression bomb. A **fifth pass** (§8) closed the
testing gaps §7 admitted to — unit tests, a fuzzer, and full route coverage — and found 3 more
issues, including a quadratic-blowup DoS in the PDF parser. All fixed.

**Test gate: 44 unit/route tests + 28 smoke checks + a PDF fuzzer, all green.**
This document is still not a claim of "secure" — §8 lists what remains.

---

## 1. Findings

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| V1 | **Critical** | **No authentication at all.** Every route (`/api/credentials`, `/api/chat/stream`, `/api/files`) was open to anyone who could reach the port. Since the server binds `0.0.0.0`, anyone on the network could spend the owner's provider credits, read every conversation, delete keys, and index repos. | Fixed |
| V2 | **Critical** | **SSRF via custom provider base URL.** `POST /api/credentials {provider:"custom", baseUrl:"http://169.254.169.254/…"}` made the server issue authenticated requests to cloud metadata / internal services, with the response body surfaced back to the attacker via error text. | Fixed |
| V3 | **Critical** | **SSRF via chat image attachments.** `images[].dataUrl` was passed straight through to the provider payload with no scheme check — `http://10.0.0.5/admin` was accepted, turning both this server and the upstream provider into a fetch proxy. | Fixed |
| V4 | **Critical** | **No CSRF protection.** All mutations were plain JSON POSTs with no origin binding, so any web page the operator visited could silently create/delete credentials and drain the API key. | Fixed |
| V5 | **Critical** | **GitHub path injection.** `owner`/`repo` were interpolated into `api.github.com/repos/${owner}/${repo}/…`. `owner: "../../users"` escaped the intended path and drove arbitrary GitHub API endpoints. | Fixed |
| V6 | **High** | **XSS via the markdown renderer's sentinel.** Code fences were replaced with the *predictable* placeholder `\x00C0\x00` **before** escaping. Model or document content containing that literal sequence got its raw contents re-inserted as HTML after escaping — a working stored-XSS path from any attacker-controlled document. | Fixed |
| V7 | **High** | **No rate limiting anywhere.** Unbounded login guessing (once auth existed), chat spend, upload flood, and repo-index amplification. | Fixed |
| V8 | **High** | **Missing security headers.** No CSP, no `X-Frame-Options` (clickjacking), no `nosniff`, no `Referrer-Policy`. | Fixed |
| V9 | **High** | **Static-file serving used `path.normalize` + `startsWith(PUBLIC_DIR)`.** The prefix check had no trailing separator (so a sibling dir `public-old/` would pass), it never decoded percent-escapes before checking, it did not reject null bytes, and it followed symlinks out of the root. Unknown extensions were also served inline as `application/octet-stream`. | Fixed |
| V10 | **Medium** | **Header injection through API keys.** A key containing `\r\n` was interpolated into the `Authorization` header. | Fixed |
| V11 | **Medium** | **Unbounded input.** 30 MB JSON bodies on every route, 50 MB uploads, no length caps on `message`/`systemPrompt`/feedback, no cap on provider stream length, no cap on fetched repo files, unvalidated `temperature`/`maxTokens`. Trivial memory exhaustion (the whole store is in RAM). | Fixed |
| V12 | **Medium** | **Prompt-injection delimiter spoofing.** Evidence was wrapped in `<<<DOCUMENT_EVIDENCE …>>>` markers, but the evidence text itself was not stripped of those markers — a document could close its own block and impersonate trusted system instructions. | Fixed |
| V13 | **Low** | **Weak secret hygiene at rest.** `data/` created with default perms; the master key was file-only (no injectable `MASTER_KEY`); store files written world-readable; a corrupt/tampered JSON file was loaded unvalidated at boot. | Fixed |
| V14 | **Low** | **Error/DoS hygiene.** Provider error text (potentially echoing a key) could reach clients; no `unhandledRejection`/`uncaughtException` handlers, no `headersTimeout`/`requestTimeout` (Slowloris), no content-type sniffing guard on uploads (any bytes accepted as `.pdf`). | Fixed |

---

## 2. Fixes

New module **`lib/security.js`** centralises the controls; `server.js`, `lib/providers.js`,
`lib/store.js` and both HTML clients call into it.

**Authentication (V1)** — single shared access token (this is a single-tenant BYOK tool, not
a multi-user product). On first boot the server generates `data/app.token` (mode `0600`) and
prints it. Override with `APP_TOKEN`, disable for a trusted-loopback dev box with
`AUTH_DISABLED=true`. Accepted as `Authorization: Bearer …` / `X-App-Token` for CLI, or
exchanged at `POST /api/auth/login` for an HMAC-signed, 12 h, `HttpOnly; SameSite=Strict`
session cookie for the browser. All comparisons are `timingSafeEqual`. Only
`/api/health/*`, `/api/auth/login` and `/api/auth/status` are public. The UI now shows an
unlock prompt on any 401.

**SSRF (V2, V3)** — `assertSafeUrl()` + `assertResolvesPublic()` reject non-http(s) schemes,
embedded credentials, `localhost`/`.local`/`.internal`/`metadata.google.internal`, and any
host that *resolves* to loopback, RFC1918, link-local (`169.254/16`), CGNAT or multicast.
Custom base URLs must be `https`, are validated on save, re-checked for shape on every use
(so a tampered store entry can't bypass it), and **re-resolved via DNS immediately before each
outbound call** so a rebinding flip to a private address is caught (see V23). Chat images must be inline
`data:image/(png|jpeg|gif|webp);base64` — max 4 attachments, 6 MB each. Provider fetches use
`redirect: 'error'` so a 302 can't walk out of the allowlist.

**CSRF (V4)** — every non-GET `/api/*` request must have an `Origin` matching the request
host (or an entry in `ALLOWED_ORIGINS`). Missing `Origin` (curl/CI) still requires the bearer
token. Verified: a cookie-bearing POST with `Origin: https://evil.example` → **403**.

**Path/param injection (V5, V9)** — `assertGithubSegment()` restricts owner/repo to
`[A-Za-z0-9._-]{1,100}`; all route ids go through `assertId()`. `resolveStatic()` decodes
first, rejects null bytes, resolves against the root **with a trailing separator**, `stat`s
for a regular file, and `realpath`s to block symlink escapes. Unknown extensions are served
`attachment`. Upload filenames are stripped of separators and control chars.

**XSS (V6)** — the code-fence placeholder is now a per-render random sentinel
(`X<random><time>X`) that content cannot predict, and all C0 control characters are stripped
from the input before rendering. Server-side, `sanitizeText()` strips control chars from
every ingested document, repo file, and message.

**Rate limiting (V7)** — per-IP token buckets: global 600/min, chat 30/min, login 5 per
5 min, uploads 20/min, credential ops 20/min, key tests 10/min, repo index 5/min, feedback
20/min. `X-Forwarded-For` is only honoured when `TRUST_PROXY=true` (otherwise a header could
forge the bucket key).

**Headers (V8)** — CSP (`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`,
`connect-src 'self'`, `form-action 'none'`), `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP, and HSTS behind TLS.
(`script-src` keeps `'unsafe-inline'` — the UI is a single self-contained HTML file; moving
the inline scripts to external files to drop it is the one remaining hardening step.)

**Input validation & DoS (V10, V11, V14)** — API keys rejected if they contain `CR/LF/NUL`
and sanitised again at the header layer; JSON bodies capped at 12 MB (32 MB for upload/chat
envelopes); uploads at 20 MB (`MAX_FILE_BYTES`); PDFs must carry the `%PDF-` magic bytes;
text ingestion capped at 5 MB; repo files capped at 200 KB each; provider streams capped at
2 MB; `temperature` bounded 0–2 and `maxTokens` to 32 000; feedback type/priority are
enumerated allowlists. Server-side: `headersTimeout` 20 s, `requestTimeout` 5 min,
`maxHeadersCount` 100, `clientError` handler, plus `unhandledRejection`/`uncaughtException`
handlers that flush the store instead of dying. 5xx responses never echo internals, and
`scrubSecrets()` redacts anything key-shaped (`sk-…`, `gsk_…`, `ghp_…`, `Bearer …`) before it
can reach a client or a log line.

**Prompt injection (V12)** — evidence text has forged `<<<…DOCUMENT_EVIDENCE…>>>` delimiters
replaced with `[redacted-delimiter]`, and `<`/`>`/`"` stripped from the source labels, so
untrusted documents cannot break out of their block.

**Secrets at rest (V13)** — `data/` is `0700`, store files `0600`, `master.key` re-chmodded
on load and length-checked; `MASTER_KEY` (64-hex) can be injected by a secret manager instead
of using the on-disk key; loaded JSON is shape-checked and prototype-stripped;
`decryptSecret()` validates the envelope before use.

---

## 3. Verification

`npm run smoke` grew 12 security assertions and now runs **19/19 green**, including:
unauthenticated `401`s, wrong-token `401`, cross-origin `403`, metadata-IP and localhost SSRF
rejection, GitHub path-injection rejection, fake-PDF rejection, remote-image-URL rejection,
and a security-header assertion.

Manual exploitation against a live instance, post-fix:

```
cookie replay with Origin: https://evil.example   → 403   (was 201)
/..%2f..%2fetc%2fpasswd, /%2e%2e/../server.js     → 404
/index.html%00.png                                 → 404
7 rapid bad logins                                 → 401 401 401 401 429 429 429
upload name "../../evil.txt"                       → stored as "_.._evil.txt"
baseUrl http://169.254.169.254/latest              → 400 "blocked (private or link-local)"
```

## 4. Residual risk / next steps

1. **`script-src 'unsafe-inline'`** — extract the inline `<script>` blocks from
   `public/*.html` into `/app.js` to enable a strict CSP.
2. **Single shared token, no user model** — fine for single-tenant BYOK; multi-user needs the
   real identity layer in build plan §13/§25.
3. **Master key on the same disk as the ciphertext** — use `MASTER_KEY` from OCI Vault/KMS in
   production (the envelope-encryption path in plan §13).
4. **In-memory rate-limit buckets** — per-process only; put Redis or the edge/WAF in front of
   a multi-instance deployment.
5. **JSON store** — no row-level access control or audit log; plan §9 replaces it with Postgres.
6. **Always deploy behind TLS** (nginx site is included) and set `TRUST_PROXY=true` +
   `FORCE_HSTS=true` there.

---

## 5. Second pass — auditing the fixes

A hardening patch is new attack surface. Re-reviewing `lib/security.js` and the wiring
adversarially turned up 7 further defects, 2 of them serious enough to fully defeat a control
I had just added.

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| V15 | **High** | **CSRF bypass via `X-Forwarded-Host`.** `checkOrigin()` preferred `X-Forwarded-Host` over `Host` unconditionally. Since that header is attacker-controlled when no proxy sets it, `Origin: https://evil.example` + `X-Forwarded-Host: evil.example` compared equal and passed. Verified live: **201 Created** on a cross-origin POST. Now only honoured when `TRUST_PROXY=true`, and an empty host never matches. | Fixed |
| V16 | **High** | **SSRF filter bypass via IPv4-mapped IPv6.** `isPrivateIp()` only unmapped the dotted form `::ffff:169.254.169.254`, but Node's URL parser normalises that to the *hex* form `::ffff:a9fe:a9fe`, which fell through as public. `http://[::ffff:169.254.169.254]/` was **accepted**. Now both spellings are unmapped and re-checked (hex pairs are decoded back to dotted quads). | Fixed |
| V17 | Medium | **`assertId()` accepted `__proto__` / `constructor`.** These are used directly as map keys (`db.messages[id]`, `db.repoFiles[id]`). `__proto__` silently discards the write, so a conversation could be created whose messages vanish — state corruption, and a footgun if the store shape ever changes. Prototype-colliding keys are now rejected. | Fixed |
| V18 | Medium | **Unmatched `/api/*` GETs fell through to the static handler**, letting API paths be answered by file-serving logic rather than a clean JSON 404. `/api/*` now always terminates in the API layer. | Fixed |
| V19 | Medium | **Evidence-block sanitiser was incomplete.** The delimiter regex only matched `DOCUMENT_EVIDENCE`-named markers, and `safeLoc` had a no-op replacement (`'"' → '"'`) that stripped nothing — so the attacker-controlled **repo path / page value** could inject `">>>` and escape the block even though the *text* was cleaned. All interpolated parts (filename, path, page) now go through one `clean()` that strips `<>"` and CR/LF and caps length; the text regex now redacts any `<<<…>>>` marker. | Fixed |
| V20 | Low | **`timingSafeEqual('', '')` returned `true`.** Harmless as wired (a token is always ≥16 chars), but if `APP_TOKEN=''` were ever set, an empty `X-App-Token` header would authenticate. Empty inputs now never match. | Fixed |
| V21 | Low | **`HEAD` requests streamed a response body** from `serveStatic`, and `.localhost` subdomains weren't in the internal-host blocklist. | Fixed |

Also confirmed **not** vulnerable during this pass: `//api/bootstrap`, `/api/./bootstrap`,
`/api/BOOTSTRAP` and trailing-slash variants all fail closed (401/404, no data); decimal
(`http://2130706433/`), hex (`0x7f000001`), short-form (`127.1`) and `0` IP encodings are
rejected by the URL parser plus the guard; DNS-rebinding-style names (`169.254.169.254.nip.io`)
are caught by `assertResolvesPublic()`'s resolution check; `Origin: null` is rejected; the
rate-limit sweep timer is `unref()`'d so it can't hold the process open.

Regression tests for V15–V21 are in `scripts/smoke.js`, including two **raw-socket** checks
(`//api/bootstrap`, `/../lib/store.js`) because `fetch()` rewrites those paths before they
reach the wire and would silently pass a broken server.

---

## 6. Third pass — critiquing the hardening itself

The first two passes asked "can I break in?". This one asks the questions a reviewer should
ask of any security patch: *does the control break the product, does it actually cover the
whole path, and does the documentation overstate it?* Six issues, one of them a genuine
availability bug I introduced.

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| V22 | **High (availability)** | **The login rate limiter was a self-inflicted DoS.** 5 failed attempts per IP returned a hard `429` for 5 minutes. Because `TRUST_PROXY` defaults off, *every* client behind a shared egress IP (or NAT, or a reverse proxy) shares one bucket — so any anonymous attacker could lock the legitimate owner out of their own workspace indefinitely by failing 5 logins every 5 minutes. Verified: after 6 bad attempts the **correct** token returned `429`. Replaced with progressive backoff (250 ms doubling to a 4 s cap after 5 attempts, hard stop only at 200), and a successful login clears the counter. Brute force stays infeasible; the owner always eventually gets in. | Fixed |
| V23 | **Medium** | **SSRF re-validation was shape-only (DNS-rebinding TOCTOU).** I claimed custom base URLs were "re-validated on every use", but `baseUrlFor()` only re-checked the *URL string*. DNS was resolved once, at save time. A host that resolved public when saved could be re-pointed at `127.0.0.1` afterwards and would pass forever. Added `assertUsableBase()`, which re-resolves immediately before every `listModels`/`streamChat` call. | Fixed |
| V24 | **Medium** | **Stored-XSS path missed by my own "all render paths escaped" claim.** The composer attachment `chip()` escaped its `label` but interpolated `id` and `kind` raw into `data-` attributes. Now escaped. (The filename *is* stored raw — correctly, since sanitising for storage is the wrong layer — so escaping must be complete at render, and it now is.) | Fixed |
| V25 | **Medium (UX)** | **The login gate never actually appeared on first load.** `bootstrap()` was called un-awaited; its `/api/bootstrap` 401 rejected into nothing, so a new user saw an empty shell with no prompt and no error — the auth feature was effectively unreachable. Boot now checks `/api/auth/status` first and renders the unlock prompt, with a `.catch()` toast on the bootstrap call. | Fixed |
| V26 | Low | **Client and server limits disagreed after hardening**, so the UI advertised and accepted uploads the server then rejected: images 10 MB client vs 6 MB server, files 50 MB vs 20 MB, and no client-side cap at all against the server's 4-image maximum. Aligned all three in both UIs, including the "up to 50 MB" help text. | Fixed |
| V27 | Low | Documentation overstated coverage: §2 said base URLs were re-validated "on every use" (V23) and implied render escaping was complete (V24). Corrected here. | Fixed |

### What I got wrong, and the lesson

Two of these (V22, V25) are the classic failure mode of security work: **the control was
measured by whether attacks fail, never by whether legitimate use still succeeds.** My own
smoke suite asserted that a wrong token gets `401` and that flooding gets `429` — both passed
— while the actual product was, in one case, lockable by any stranger and, in the other,
showing new users a blank page instead of the sign-in prompt it depended on. Exploit-only
tests will happily certify a broken product. The suite now covers the success paths too, and
the live sweep re-runs upload/indexing/conversation/usage after every change.

V23 and V27 are the second failure mode: **the write-up drifted ahead of the code.** "Re-validated
on every use" was true of the string and false of the DNS lookup, which is precisely the half
that matters for rebinding.

---

## 7. Fourth pass — the parsers, and what is still not done

The first three passes reviewed the HTTP surface and the patch itself. Neither looked hard at
the code that chews on untrusted **bytes**. That turned out to be where the remaining
vulnerability was.

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| V28 | **High** | **PDF decompression bomb.** `lib/pdf.js` called `zlib.inflateSync()` on every `/FlateDecode` stream with no output cap. ~80 KB of compressed zeros inflates to 80 MB — comfortably under the 20 MB upload limit on the way in, and allocated straight onto a heap that also holds the entire JSON store. A handful of concurrent uploads OOMs the process. Now capped with `maxOutputLength` (8 MB per stream, 64 MB per document); the 80 MB bomb is rejected in **15 ms at 4 MB heap**, and legitimate compressed PDFs still extract correctly. | Fixed |

Probed and found **not** vulnerable: catastrophic backtracking in the PDF text/object regexes
(`BT` without `ET`, unterminated objects, 20 k escape sequences — all ≤1 ms), and `/Kids`
reference cycles in the page tree (guarded by the existing `seen` set).

### Honest status

Four passes found 28 issues. The trend is the point: pass 1 found 14, pass 2 found 7 *in the
fixes*, pass 3 found 6 more, pass 4 found 1. Converging, not converged. Specifically:

**Known and unfixed**

1. **`script-src 'unsafe-inline'`** — the single biggest remaining weakness. The UI is one
   self-contained HTML file, so the CSP cannot block inline script, which is exactly the
   control that would contain an XSS if one of the ~40 `innerHTML` sites is ever wrong.
   Fixing it means extracting the inline `<script>` into `/app.js`.
2. **DNS-rebinding window is narrowed, not closed** (V23) — Node re-resolves inside `fetch`,
   so a sub-millisecond flip between check and connect is still possible. Closing it needs
   IP-pinning via a custom agent.
3. **Rate limits are per-process, in-memory** — useless across replicas, and reset on deploy.
4. **No CSRF token, only origin checking** — correct for modern browsers; a browser that
   omits `Origin` on same-site POSTs would fail open (none in current support matrix).

**Untested, which is not the same as safe**

5. **Coverage is 11 of 30 routes.** Conversation/feedback/repo mutation paths have no
   assertions at all.
6. **No unit tests for the security primitives.** `isPrivateIp`, `resolveStatic`,
   `validateImages` and the session HMAC are only exercised indirectly through HTTP.
7. **Never run against a real provider.** No API key exists in this environment, so
   `streamChat`, SSE framing, usage accounting and the whole provider error path are
   unverified end-to-end.
8. **No dependency/supply-chain risk** (zero npm deps) but also **no fuzzing** of `lib/pdf.js`,
   which is bespoke binary parsing — historically the highest-yield target in this codebase,
   as V28 demonstrates.
9. **The auth model is one shared token.** No users, no roles, no audit trail, no revocation
   beyond rotating the token. Adequate for single-tenant BYOK; not a multi-user product.

---

## 8. Fifth pass — building the tests §7 said were missing

§7 listed three admitted gaps: no unit tests for the security primitives, no fuzzing of the
PDF parser, and 11-of-30 route coverage. Closing them found 3 more defects.

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| V29 | **High** | **Quadratic blowup in the PDF object scanner (algorithmic DoS).** Found by the new fuzzer, which flagged a `repetition` case at **1734 ms**. The object regex `/(\d+)\s+\d+\s+obj([\s\S]*?)endobj/g` starts a lazy scan at every `N 0 obj` header; when no `endobj` follows, each of the *n* headers scans to EOF — O(n²). A 280 KB file of `"1 0 obj"` repeated 40 000 times burns ~1.3 s of CPU on a single-threaded server that accepts 20 MB uploads. Rewritten to find each header then `indexOf('endobj')` and resume past it: **1262 ms → 0 ms**, and 160 k repetitions now costs 1 ms. Multi-page flate-compressed PDFs still extract correctly. | Fixed |
| V30 | Medium | **GitHub rate limit metered before validation.** `POST /api/github` consumed its 5/min budget on requests that were about to be rejected as malformed, so six bad requests locked out legitimate indexing and returned a misleading `429` for what was actually a `400`. Validation now runs first. | Fixed |
| V31 | Medium | **413 responses reset the connection.** `readBody()` called `req.destroy()` on oversize input, so the client saw a TCP reset (`status 0`) rather than a usable status code. The first fix — `req.pause()` — was worse: it stalled the socket and **wedged the next keep-alive request for 5 s**, caught only because the route suite asserts the server is still healthy afterwards. Correct fix: drain and discard, respond 413, and set `Connection: close`. | Fixed |

### What was built

**`test/security.test.js` — 22 unit tests** covering `isPrivateIp` (both IPv4-mapped IPv6
spellings), `assertSafeUrl` (schemes, embedded credentials, obfuscated IP encodings),
`assertResolvesPublic`, `assertId`/`assertGithubSegment` (prototype keys, traversal),
`validateImages`, `resolveStatic` (traversal, null bytes, symlink escape, prefix-sibling
directories), `timingSafeEqual`, the session HMAC (tamper, expiry, cross-token replay),
`checkOrigin` (including the V15 `X-Forwarded-Host` forgery), `clientIp`, the rate limiters,
and the CSP header set.

**These tests were themselves validated by mutation testing.** Reverting the V15, V16 and
symlink-escape fixes made the suite fail (2, 1 and 1 tests respectively) — confirming it
detects regressions rather than merely passing.

**`test/pdf.fuzz.js`** — 10 generators (structured fragments, noise, valid/corrupt flate,
decompression bombs, pathological repetition, cyclic page trees, length lies, escape
sequences, truncation) with a deterministic seed for reproducibility. A case fails if the
parser throws, exceeds a time budget, or grows the heap past a cap. Post-fix: **6000 cases,
worst case 13.5 ms** (was 1734 ms).

**`test/routes.test.js` — 22 integration tests** taking route coverage from 11/30 to **30/30**.
Three table-driven tests assert that *every* protected route rejects no-auth, rejects a bad
token, and enforces the CSRF origin check — so a newly added route that forgets its gate fails
automatically. Plus full CRUD lifecycles (conversations, files, feedback, credentials),
key-leakage assertions (the raw key must not appear in create/list/bootstrap responses),
consent handling for feedback metadata, and malformed/oversized body handling.

Wired into `npm test`, `npm run fuzz`, and `npm run check`.

### Residual risk, updated

Fixed since §7: unit tests (7.6), fuzzing (7.8), route coverage (7.5).
**Still outstanding:**

1. **`script-src 'unsafe-inline'`** — unchanged, and still the biggest weakness. Needs the
   inline `<script>` extracted from `public/*.html` into `/app.js`.
2. **DNS-rebinding window narrowed, not closed** (V23) — needs IP-pinning via a custom agent.
3. **Rate limits are per-process and in-memory** — no good across replicas.
4. **Never run against a real provider** — no API key in this environment, so `streamChat`,
   SSE framing, usage accounting and provider error mapping remain unverified end-to-end.
   The route tests cover everything *up to* the outbound call.
5. **One shared token, no users/roles/audit trail.**
