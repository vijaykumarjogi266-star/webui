# Changelog — AI Workspace

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/). Pre-1.0, so minor bumps may break things.

---

## [1.0.0-rc.1] — 2026-09-04

First release candidate. The demo build from `0.1.0` is now gated, hardened and
covered by an automated test suite. **Breaking for existing installs:** the app
now requires an access token.

### Added

- **Access-token authentication** (`lib/security.js`). Generated on first boot,
  printed to the console, stored at `data/app.token` (mode 0600). Override with
  `APP_TOKEN` (minimum 16 characters); `AUTH_DISABLED=true` for a trusted
  loopback dev box. Browsers exchange it at `POST /api/auth/login` for an
  HMAC-signed, 12-hour, `HttpOnly; SameSite=Strict` cookie; CLI clients send
  `Authorization: Bearer`. New routes: `/api/auth/{status,login,logout}`.
- **CSRF protection** — every state-changing `/api` request must carry an
  `Origin` matching the request host, or an entry in `ALLOWED_ORIGINS`.
- **SSRF egress guard** — custom provider base URLs and chat image attachments
  are validated against loopback, RFC1918, link-local (`169.254.0.0/16`), CGNAT
  and multicast ranges, with a DNS resolution check and re-resolution before
  every outbound call.
- **Rate limiting** — per-IP token buckets per route class, with progressive
  backoff on login rather than a hard lockout.
- **Security headers** — CSP, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, and HSTS behind TLS.
- **Test suite** (`test/`, committed — note `tests/` is git-ignored):
  - `security.test.js` — 23 unit tests for the security primitives, validated by
    mutation testing.
  - `routes.test.js` — 22 integration tests; table-driven assertions that *every*
    protected route enforces auth and CSRF, so a new route cannot skip its gate.
  - `ui.boot.test.js` — evaluates both front-end bundles against a stub DOM.
  - `pdf.fuzz.js` — 10-generator fuzzer with deterministic seed and time/heap
    budgets.
  - `npm test`, `npm run fuzz`; both wired into `npm run check`.
- **CI** — `.github/workflows/ci.yml` now active (previously a parked template),
  running the zero-dependency assertion, tests, fuzzer, smoke gate, a CSP
  regression check, and a secret scan.
- `SECURITY.md` — full review record: 34 findings across six passes.
- `LICENSE` and this changelog.

### Changed

- **Front end split into external assets** — `public/index.{html,css,js}` and
  `public/atelier.{html,css,js}`. This let `script-src` drop `'unsafe-inline'`;
  an injected `<script>` or `onerror=` handler no longer executes. Inline
  `onclick=` handlers were replaced with a delegated `[data-goto]` listener.
- `make-demo.js` re-inlines those assets so `demo-*.html` stay single-file.
- Upload limits aligned between client and server: 20 MB files, 6 MB images,
  4 images per message (the UI previously advertised 50 MB / 10 MB / unlimited).
- Error responses are scrubbed of key-shaped strings; 5xx bodies no longer echo
  provider payloads or stack traces.
- Store hardening: `data/` is `0700`, files `0600`, `MASTER_KEY` can be injected
  from a secret manager, and loaded JSON is shape-checked.

### Fixed

Highlights; all 34 findings are detailed in `SECURITY.md`.

- **No authentication whatsoever** — every route was open to anyone who could
  reach the port (the app binds `0.0.0.0`). *(V1, critical)*
- **SSRF** via custom provider base URLs and via chat image `dataUrl`s, allowing
  authenticated requests to cloud metadata and internal services. *(V2/V3, critical)*
- **GitHub path injection** — `owner: "../../users"` escaped the API path. *(V5, critical)*
- **Stored XSS** — the markdown renderer used a *predictable* code-fence
  placeholder, re-inserting attacker content as raw HTML after escaping. *(V6, high)*
- **CSRF bypass** — `X-Forwarded-Host` was trusted unconditionally, defeating the
  origin check. *(V15, high)*
- **SSRF filter bypass** — IPv4-mapped IPv6 (`::ffff:a9fe:a9fe`, the form Node's
  URL parser produces) was treated as public. *(V16, high)*
- **Self-inflicted DoS** — the new login limiter let any anonymous client lock
  the legitimate owner out of their own workspace. *(V22, high)*
- **PDF decompression bomb** — ~80 KB of FlateDecode inflating to 80 MB on the
  same heap as the store. *(V28, high)*
- **Quadratic blowup in the PDF object scanner** — 280 KB of crafted input cost
  ~1.3 s of CPU; now 0 ms. Found by the fuzzer. *(V29, high)*
- **Login gate never rendered** — `bootstrap()` was un-awaited, so its 401
  rejected into nothing and new users saw a blank shell. *(V25)*
- **Silent `APP_TOKEN` fallback** — a too-short token was ignored in favour of a
  generated one, so the configured credential simply did not work. Now aborts
  startup with an explicit error. *(V32)*
- **TDZ crash in `atelier.js`** — a top-level statement used `$` before its
  `const` declaration; harmless while inline, fatal once deferred. Caught by the
  new boot test. *(V34)*

### Known limitations

Stated plainly in `SECURITY.md` §9 and `BUILD_REVIEW.md` §3:

- Single shared token — no per-user identity, roles, workspace isolation or
  audit trail. Suitable for single-tenant BYOK, not multi-tenant.
- The provider streaming path has never been exercised against a real API key in
  CI; tests cover everything up to the outbound call.
- `style-src-attr 'unsafe-inline'` remains (~80 `style=""` attributes). Style
  attributes cannot execute script.
- DNS-rebinding window is narrowed, not closed.
- Rate limits are per-process and in-memory; they do not span replicas.
- JSON file store, synchronous upload parsing, BM25-only retrieval, no OCR —
  each maps to a production-plan section.

---

## [0.1.0] — 2026-09-03

Initial zero-dependency demo build: BYOK encrypted key vault, SSE streaming chat
across OpenRouter/Groq/OpenAI-compatible providers, PDF and text RAG with page
citations, vision gating, GitHub public-repo Q&A, feedback triage, usage and cost
tracking, health endpoints, and a deploy layer (Docker, compose, Procfile,
Render/Fly/Railway manifests, systemd + nginx). Accepted as a reference
implementation in `BUILD_REVIEW.md` (12/12 acceptance battery).
