# AI Web UI — Plan, Review, and Working Build

Delivered against the V3 master prompt ("Expert-Level AI Web UI Build Prompt"). Three deliverables:

| Path | What it is |
|---|---|
| `ai-web-ui-plan/AI_WEB_UI_BUILD_PLAN.md` | The complete expert build plan (v1.1): 47 sections — architecture, full DB schema, provider layer, RAG pipeline, security/threat model, OCI deployment, CI/CD, expert review, scored rubric, production gates |
| `ai-web-ui-plan/END_USER_REVIEW.md` | 4-persona end-user walkthrough with 14 findings and release recommendation |
| `ai-workspace/` | **A running implementation** of the MVP core (zero npm dependencies): BYOK encrypted key vault, SSE streaming chat, PDF/text RAG with page citations, vision gating, GitHub repo Q&A, feedback + triage, usage/cost tracking — see `ai-workspace/BUILD_REVIEW.md` for the acceptance battery (12/12 green) and open production gaps |
| `ai-workspace/SECURITY.md` | **Security review and hardening record**: 32 findings across five adversarial passes (including audits of the fixes themselves), each with severity, reproduction and remedy — plus a plainly stated residual-risk list |

## Quick start (the app)

```bash
cd ai-workspace
node server.js        # → http://localhost:3000 (Node 20, no npm install)
```

**The app is gated by an access token.** On first boot the server generates one, prints it to
the console, and stores it at `data/app.token` (mode 0600). Paste it into the unlock prompt in
the UI, or send it as `Authorization: Bearer <token>`. Set `APP_TOKEN` to choose your own
(minimum 16 characters — a shorter value aborts startup rather than being silently ignored),
or `AUTH_DISABLED=true` on a trusted loopback dev box.

Then add an OpenRouter/Groq key in Provider settings (or complete the first-run wizard), chat,
upload a PDF, and ask about it. (Note: `ai-workspace/tests/` is git-ignored, so the sample
`meridian-q3.pdf` mentioned in the review docs is a local fixture — use any text PDF. The
committed suites live in `ai-workspace/test/`.)

### Tests

```bash
cd ai-workspace
npm test        # 48 unit + route tests (security primitives, per-route gates, UI boot)
npm run fuzz    # PDF parser fuzzer (deterministic seed; found a quadratic-blowup DoS)
npm run smoke   # 30-check deploy gate, 23 of them security assertions
npm run check   # all of the above
```

## Deploy

`ai-workspace/` ships a full deploy layer for this zero-dependency build: `package.json`
(`start` / `smoke` / `check`), `Dockerfile` (non-root, healthcheck, SIGTERM-aware),
`docker-compose.yml`, `Procfile`, Render/Fly/Railway manifests, a hardened systemd unit +
nginx site for an OCI compute VM, a `data/` backup-restore script, and a CI workflow.
Details and the persistence caveat: `ai-workspace/deploy/README.md`.


## Security

`ai-workspace/` was reviewed as an attacker and hardened over five passes — each one also
auditing the previous pass's fixes. **34 findings, all fixed**, recorded with reproductions in
[`ai-workspace/SECURITY.md`](ai-workspace/SECURITY.md):

- **Pass 1 (14)** — no authentication at all, SSRF via custom provider base URLs and image
  attachments, CSRF, GitHub path injection, a markdown-renderer XSS, missing rate limits and
  security headers, path traversal, secret hygiene
- **Pass 2 (7)** — defects *in the hardening itself*: a CSRF bypass via `X-Forwarded-Host` and
  an SSRF bypass via IPv4-mapped IPv6 both fully defeated controls added in pass 1
- **Pass 3 (6)** — availability and correctness: the new brute-force limiter locked the
  legitimate owner out of their own workspace, and the login gate never actually rendered
- **Pass 4 (1)** — a PDF decompression bomb (80 KB inflating to 80 MB)
- **Pass 5 (4)** — found by building the tests pass 4 admitted were missing, including a
  quadratic-blowup DoS in the PDF object scanner (1262 ms → 0 ms)
- **Pass 6 (2)** — removed the `'unsafe-inline'` CSP weakness by splitting the front end into
  external assets, and caught a temporal-dead-zone crash that the split introduced (it blanked
  the whole page, and only an executing boot test could see it)

Controls now in `lib/security.js`: shared-token auth with an HMAC session cookie, origin-bound
CSRF, a DNS-resolving SSRF allowlist, per-IP/per-route rate limiting, a full security-header
set with CSP, strict input validation, and traversal/symlink-safe static serving.

**This is not a claim of "secure."** `SECURITY.md` §9 lists what remains. The most important
item: **the provider streaming path has never been exercised against a real API key** — the
tests cover everything up to the outbound call, so do one manual run with a real key before
trusting a production deploy. Also open: a narrowed-but-not-closed DNS-rebinding window,
in-memory rate limits that don't span replicas, and single-token auth with no per-user
identity or audit trail.

## Document map

- Plan §1–§9: goals, personas, phasing, architecture, stack, design system, repo structure, schema
- Plan §10–§15: providers, capability registry, reliability, key security, chat UI, prompt governance
- Plan §16–§24: documents/RAG, images, GitHub connector, feedback, workspaces, templates, usage, privacy
- Plan §25–§34: threat model, API routes, jobs, OCI deployment, IaC, Docker, CI/CD, secrets, observability, backup/rollback
- Plan §35–§47: testing, journeys, checklists, DoD, ADRs, docs, expert review, gap analysis, rubric, readiness gates, roadmap, changelog

## Status

- Plan: v1.1 complete (end-user fixes absorbed — §47 changelog)
- Demo build: accepted as reference implementation; production blockers listed in `ai-workspace/BUILD_REVIEW.md` §3
- Security: hardened over five adversarial passes — 32 findings, all fixed (`ai-workspace/SECURITY.md`). The build review's *"no authentication"* critical blocker is now closed for the single-tenant case; multi-user auth (roles, workspace isolation, audit trail) remains plan work
- Tests: 48 unit + route tests, a PDF fuzzer, and a 30-check smoke gate — `npm run check`
- CI: active at `.github/workflows/ci.yml` (tests, fuzz, smoke, CSP regression, secret scan)
- Release: `1.0.0-rc.1` — see `ai-workspace/CHANGELOG.md`
- Deploy layer: added — Node manifests + Docker + VM/PaaS runbook in `ai-workspace/deploy/`
- GitHub: pushed to `https://github.com/vijaykumarjogi266-star/webui` (the earlier "no remote/credentials in this environment" note is obsolete)

