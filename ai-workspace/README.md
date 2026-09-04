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

## Run

```bash
node server.js        # → http://localhost:3000
PORT=8080 node server.js
```

No `npm install`. Data persists in `./data/*.json`; master key auto-generated at `./data/master.key` (mode 0600).

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
