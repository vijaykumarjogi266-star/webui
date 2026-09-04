# Build Review — AI Workspace (working demo implementation)
**Reviewed:** the running application in this directory, built from `../ai-web-ui-plan/AI_WEB_UI_BUILD_PLAN.md`
**Method:** code review + a 12-point automated acceptance battery against the live server + manual API walkthroughs
**Verdict:** ✅ **Accepted as a working reference implementation of the MVP core.** Not production-ready by design — every gap maps to a section of the production plan that closes it.

> **Update — security hardening.** This review predates the adversarial security work recorded
> in [`SECURITY.md`](SECURITY.md): 32 findings across five passes, all fixed, plus a committed
> test suite (`npm run check` → 45 unit/route tests, a PDF fuzzer, 28 smoke checks). The
> *"no authentication"* blocker in §3 below is now partially closed — annotated inline. Other
> §3 gaps (async upload pipeline, KMS envelope encryption, embeddings, OCR, Postgres) are
> unchanged. Read the two documents together.

---

## 1. What was built and proven (evidence)

Zero npm dependencies; Node 20 stdlib only. ~19 endpoints across one server module + 3 library modules (store/pdf/rag/providers) + one self-contained SPA.

| # | Acceptance check | Result |
|---|---|---|
| 1 | Frontend script parses cleanly (`node --check` gate) | ✅ pass |
| 2 | `/api/health/live` + `/ready` respond | ✅ pass |
| 3 | API key never appears in any response after save (masking audit across `/api/bootstrap` + `/api/credentials`) | ✅ pass |
| 4 | Invalid key → graceful `invalid_key` with friendly copy; credential status flipped to `failed` | ✅ pass |
| 5 | GitHub connector end-to-end: connect `octocat/Hello-World` → README indexed (extension-less file handled) → file preview serves content | ✅ pass |
| 6 | Capability gate: image attached + text-only model → server returns 400 `vision_unsupported` (defense in depth; UI also blocks) | ✅ pass |
| 7 | RAG: "How much did Meridian revenue grow?" with PDF attached → BM25 retrieves the correct chunk, `start` event carries citation `{source:'meridian-q3.pdf', page:1}` | ✅ pass |
| 8 | PDF parser handles both plain and FlateDecode-compressed content streams, preserves page numbers (2-page fixture → 2 chunks) | ✅ pass |
| 9 | Feedback lifecycle: submit → status transition recorded in history; invalid status rejected 400 | ✅ pass |
| 10 | File validation: `.exe` rejected with actionable message; 50 MB limit enforced | ✅ pass |
| 11 | Provider failure UX: fake key mid-chat streams `event: error` with mapped friendly message (no raw JSON to users) | ✅ pass |
| 12 | Usage endpoint aggregates tokens/cost with honest nulls where pricing is unavailable | ✅ pass |

Also implemented: SSE streaming with abort propagation, stop-generation, conversation persistence + auto-titling, model registry with vision heuristics + pricing + context windows, first-run wizard (skippable, with key-acquisition links), dark/light theme, feedback triage UI, cost-per-Mtok badges, evidence-boundary injection defense in the default system prompt.

## 2. Bugs found and fixed during this review

| ID | Bug | Severity | Fix | General lesson |
|---|---|---|---|---|
| B1 | `/api/chat/stream` handler received the router's regex match instead of the parsed JSON body → every chat request 400'd | High | Wrapped route to `readJson()` first | Route-handler contracts need one integration test each; would have been instant with the plan's smoke suite (§37.4) |
| B2 | OpenRouter's `/models` endpoint is public — "Test connection" passed with a completely fake key | High | Added `verifyKey()` using the authenticated `/auth/key` endpoint (OpenRouter) / authed `/models` (Groq, custom) | Connection tests must hit an endpoint that actually authenticates; recorded as plan note for §10.2 |
| B3 | Markdown renderer's code-fence placeholder had an unbalanced paren — the entire inline script would have failed to parse in the browser | High | Rewrote `md()` with a token-store (no base64 nesting); added `node --check` to the verification battery | No-build vanilla JS still needs a parse gate in CI |
| B4 | GitHub indexer skipped extension-less files (`README`, `Dockerfile`, `Makefile`) → tiny repos indexed 0 files | Medium | `KNOWN_FILENAMES` allow-set | Indexer allow-lists should be fixture-tested per plan §40.4 |
| B5 | JSON persistence used direct `writeFileSync` — a crash mid-write would corrupt the store | Medium | Atomic tmp-file + rename | Even demo storage gets atomic writes; cheap |

## 3. Expert findings against the production plan (open items)

Format per master prompt §44. All are **by-design demo simplifications** — each names the plan section that closes it.

```text
Issue: No authentication, roles, or workspace isolation — single-user tool
Severity: Critical (for production) / Acceptable (single-machine demo)
Status: PARTIALLY CLOSED — see SECURITY.md. A shared access-token gate (HMAC session
  cookie, origin-bound CSRF, per-route rate limiting) now protects every /api route, so the
  app is no longer wide open to anyone who can reach the port. Roles, per-user identity,
  workspace isolation and an audit trail are still NOT implemented.
Why it matters: Every production gate in plan §22/§46 depends on AuthN+AuthZ; multi-tenancy without it is a data-leak machine.
Recommended fix: Implement plan M1 (Auth.js + RBAC + workspace scope helper + IDOR battery) before any shared deployment.
Owner: Backend
Acceptance test: Journey 6 cross-tenant matrix green.
Production blocker: Yes for multi-tenant. Single-tenant BYOK deployments are now defensible behind TLS.

Issue: Local master key file instead of OCI KMS envelope encryption
Severity: High (prod) / Acceptable (demo, mode-0600 key, AES-256-GCM)
Why it matters: Key compromise on the host exposes all BYOK keys; no rotation story.
Recommended fix: Plan §13 envelope scheme with KMS-wrapped DEKs + key-version column (schema already designed).
Owner: Security
Acceptance test: Chaos test — no plaintext key in logs/errors/responses; rotation drill.
Production blocker: Yes

Issue: Upload parsing runs synchronously inside the HTTP request
Severity: High (prod)
Why it matters: A 50MB PDF blocks the event loop for seconds — one upload stalls all users' streams.
Recommended fix: Plan §27 async pipeline: enqueue on upload, worker processes, UI shows status badge.
Owner: Backend
Acceptance test: 40MB upload returns <500ms while chat p95 stays <3s (plan §42 finding).
Production blocker: Yes

Issue: Keyword BM25 retrieval only — no embeddings, no rerank
Severity: Medium
Why it matters: Semantic queries ("what are our hiring commitments?") miss paraphrased evidence.
Recommended fix: Plan §17 hybrid pgvector+FTS with RRF; embedding provider configuration (Groq has no embeddings — guidance designed in §10.3).
Owner: AI/RAG
Acceptance test: RAG eval suite (§17.3) recall@6 ≥ 0.9.
Production blocker: No for demo; Yes for prod PDF Q&A SLO (95%).

Issue: No OCR fallback — scanned PDFs fail honestly but uselessly
Severity: Medium
Why it matters: Plan S3 (95% of valid PDFs) is unreachable without OCR for the scanned subset.
Recommended fix: Plan §16.3 Tesseract path in the Python doc-processor, consent prompt, confidence display.
Owner: AI/RAG
Acceptance test: Scanned fixture PDF answers with OCR badge.
Production blocker: No (honest failure today); Yes before GA.

Issue: No retries, circuit breaker, or fallback on provider calls
Severity: Medium
Why it matters: Single 429/5xx surfaces straight to the user; plan §12 promises backoff + breaker + opt-in fallback.
Recommended fix: Implement §12 table as specced (3 retries, breaker, per-credential cooldown cache).
Owner: Backend
Acceptance test: Fixture-driven 429/5xx tests.
Production blocker: Yes (reliability gate).

Issue: Images travel to providers as full data URLs with EXIF intact
Severity: Medium
Why it matters: GPS/metadata exfiltration risk; plan §17.1 strips EXIF and requires explicit analysis intent.
Recommended fix: Server-side thumbnail/transcode + metadata strip before send.
Owner: Backend
Acceptance test: Uploaded JPEG with GPS EXIF → provider payload contains no EXIF bytes.
Production blocker: Yes (privacy gate).

Issue: Unauthenticated GitHub API, sequential raw-file fetches, no incremental re-index
Severity: Medium
Why it matters: 60 req/h ceiling; indexing a 60-file repo takes minutes; re-index refetches everything.
Recommended fix: Plan §19 GitHub App + installation tokens, batched fetch, commit-SHA diffing.
Owner: GitHub connector team
Acceptance test: Re-index of unchanged repo fetches ≤2 API calls.
Production blocker: Yes (for private repos at all).

Issue: No rate limiting, CSRF, or security headers
Severity: High (prod) / N/A (localhost single user)
Recommended fix: Plan §26 route-class limits, SameSite cookies + CSRF token, CSP.
Owner: Backend
Production blocker: Yes

Issue: Provider calls have no prompt-version record on messages
Severity: Low
Why it matters: Plan §15 requires knowing which system prompt produced each answer.
Recommended fix: Tag messages with `promptVersion: 'assistant-core@1.0.0'` (constant today; versioned in prod).
Owner: AI
Production blocker: No

Issue: Feedback has no attachments, notifications, or assignment; usage has no limits
Severity: Low (demo)
Recommended fix: Plan §20.4–20.6 and §23 control set.
Production blocker: No for demo completeness; items are MVP in the plan.
```

## 4. Scored rubric — demo build vs production plan

| Category | Demo score | Path to 5 |
|---|---|---|
| Provider integration | 4.5 | retries/breaker/fallback (§12) |
| API-key security | 3.5 | KMS envelope + rotation drill |
| Chat experience | 4.5 | edit/regenerate, search |
| PDF/document handling | 3.5 | OCR + async pipeline + embeddings |
| Image handling | 3.0 | EXIF strip + provider limits table |
| GitHub connector | 3.5 | tokens, batching, incremental index |
| Feedback system | 4.0 | attachments, assignment, notify |
| User friendliness | 4.5 | — (wizard, states, microcopy all present) |
| Security | 2.5 | auth, headers, limits (demo is single-user) |
| Performance | 3.5 | async ingestion, cache headers |
| Observability | 2.0 | structured logs, metrics, traces |
| Code quality | 4.0 | tests-in-CI, lint, build step |

**Interpretation:** the demo is deliberately a *vertical slice done honestly* — every feature that exists works end-to-end and fails gracefully, while the plan's M1–M5 milestones close every Critical/High above in order.

## 5. Run it

```bash
cd ai-workspace && node server.js    # http://localhost:3000 — no npm install
```

Add an OpenRouter or Groq key in **Provider settings** (or via the first-run wizard), then: chat → attach the sample PDF from `tests/` → ask about it → watch the page-1 citation. Connect a public repo on the **GitHub** page. Submit something on the **Feedback** tab and triage it on the right.

*— Build review complete. All 12 acceptance checks green; 5 build bugs found and fixed; 11 open items documented with owners, fixes, and blocker status.*
