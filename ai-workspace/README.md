# AI Workspace — working demo build

A running implementation of the MVP core from `../ai-web-ui-plan/AI_WEB_UI_BUILD_PLAN.md` (§47 V3 master prompt), built with **zero npm dependencies** (Node 20 standard library only) so it boots instantly and is trivially auditable.

## What actually works here

| Capability | Implementation |
|---|---|
| BYOK provider keys | OpenRouter · Groq · custom OpenAI-compatible; AES-256-GCM encrypted at rest (`lib/store.js`), masked previews, test / rotate / delete, server-side calls only |
| Model registry | Live `/models` fetch per provider, vision detection (provider metadata + heuristics), context windows, per-Mtok pricing, 10-min cache + manual refresh |
| Streaming chat | SSE passthrough (`/api/chat/stream`), stop generation, usage capture, per-message token/cost line, conversation history + titles |
| Capability gating | Image + text-only model → blocked with "show vision models" action (client + server enforced) |
| Documents (RAG) | PDF text extraction with page mapping + FlateDecode inflate (`lib/pdf.js`), TXT/MD/CSV/JSON/code ingestion, page-aware chunking, BM25 retrieval (`lib/rag.js`), evidence blocks with boundary markers, `[file · p.N]` citations |
| Images | Base64 attachment to vision models; EXIF note: metadata travels to provider inside the data URL — strip before sensitive use |
| GitHub connector | Public repos (unauthenticated, read-only): tree fetch, secret-pattern skip detection, indexing budget, repo Q&A with path citations, file browser |
| Feedback | 10 types, priority, consent-gated diagnostics, server-side storage, admin triage with status history |
| Usage & cost | Per-call logs, per-conversation rollups, honest "no pricing" states |
| Governance | Versioned default system prompt with retrieval-boundary injection defense; refusal phrasing rule |
| Ops | `/api/health/live` + `/ready`, graceful SIGTERM persistence |

## Reviews

- [`LAUNCH_REVIEW.md`](LAUNCH_REVIEW.md) — end-user and power-user walkthroughs against a live
  server, with a scorecard and the ten-minute live-key check to run before declaring 1.0.
- [`SECURITY.md`](SECURITY.md) — 40 findings across eight passes.
- [`BUILD_REVIEW.md`](BUILD_REVIEW.md) — acceptance battery and production gaps.

## Utility console

**With the server running: <http://localhost:3000/utility.html>** — a single page for driving
the project: live status probe, token sign-in, an API request tester with presets and
pretty-printed responses, a file-to-base64 upload helper, plus links to the app, the offline
demos and every doc. Served outside the auth gate, so it is reachable before you sign in.

## Run

```bash
node server.js        # → http://localhost:3000
PORT=8080 node server.js
```

No `npm install`. Data persists in `./data/*.json`; master key auto-generated at `./data/master.key` (mode 0600).

## Deploy

The `package.json` + `Dockerfile` + PaaS manifests in this directory are the deploy layer —
`npm start`, `npm run smoke` (boot/route/graceful-shutdown gate), `docker compose up --build`,
plus Render/Fly/Railway/OCI-VM variants: see **[deploy/README.md](deploy/README.md)**.

One rule: `/app/data` must be a persistent volume. It holds the JSON store *and*
`master.key`, which is the only thing that decrypts saved provider keys.

```bash
docker build -t ai-workspace:local .
docker run -d -p 3000:3000 -v ai-workspace-data:/app/data ai-workspace:local
node scripts/smoke.js   # 8/8 green = healthy boot
```

## API surface

`/api/health/live|ready` · `/api/bootstrap` · `/api/credentials[/:id[/test|/rotate]]` · `/api/models?cred=` · `/api/models/refresh` · `/api/conversations[/:id]` · `/api/chat/stream` (SSE) · `/api/files` · `/api/github[/:id/file]` · `/api/feedback[/:id]` · `/api/usage`

## Deliberate demo-grade simplifications (see BUILD_REVIEW.md)

- Local master key instead of OCI KMS envelope encryption
- BM25 instead of pgvector hybrid retrieval + rerank
- No OCR fallback (scanned PDFs report `ocr-needed` honestly)
- Single-user, no auth/RBAC (single-machine tool)
- Unauthenticated GitHub API (60 req/h, public repos only)
- No rate limiting or malware scan hook
- JSON file store instead of PostgreSQL

Every simplification maps to a production-plan section that closes it.

## Security

This build is gated by an access token and hardened against the findings in
[`SECURITY.md`](SECURITY.md): 14 issues from an adversarial review — missing auth, SSRF via
custom provider base URLs and image attachments, CSRF, GitHub path injection, a markdown-
renderer XSS, missing rate limits and security headers, path traversal, secret hygiene — plus
17 more found by four further passes that audited the fixes themselves — a CSRF bypass via
`X-Forwarded-Host`, an SSRF bypass via IPv4-mapped IPv6, a login limiter that locked out the
legitimate owner, a PDF decompression bomb, and a quadratic-blowup DoS in the PDF parser
caught by the fuzzer. 34 findings total; all fixed.

On first boot the server prints a generated access token and stores it at `data/app.token`
(mode 0600). Paste it into the unlock prompt in the UI, or send it as
`Authorization: Bearer <token>`. Override with `APP_TOKEN`; set `AUTH_DISABLED=true` only on a
trusted loopback dev box. Always deploy behind TLS with `TRUST_PROXY=true` and `FORCE_HSTS=true`.

```bash
npm test        # 48 unit + route tests (security primitives, every route's auth/CSRF gate)
npm run fuzz    # PDF parser fuzzer (deterministic seed; found the V29 quadratic DoS)
npm run smoke   # 30-check deploy gate, 23 of them security assertions
npm run check   # all of the above
```
