# Security review & hardening — AI Workspace

Adversarial (ethical-hacking) review of the `ai-workspace/` build, followed by fixes.
Everything below was reproduced against a running instance before and after the patch.

**Scope:** `server.js`, `lib/{store,providers,rag,pdf}.js`, `public/{index,atelier}.html`,
`scripts/smoke.js`, `Dockerfile`, deploy layer.
**Method:** source review + live exploitation (curl) against `127.0.0.1:3000`.
**Result:** 14 findings — 5 critical, 4 high, 3 medium, 2 low. All fixed. Smoke gate 19/19.

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
Custom base URLs must be `https`, are validated on save **and re-validated on every use**
(so a tampered store entry can't bypass it). Chat images must be inline
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
