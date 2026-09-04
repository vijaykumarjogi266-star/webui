# AI Web UI — Plan, Review, and Working Build

Delivered against the V3 master prompt ("Expert-Level AI Web UI Build Prompt"). Three deliverables:

| Path | What it is |
|---|---|
| `ai-web-ui-plan/AI_WEB_UI_BUILD_PLAN.md` | The complete expert build plan (v1.1): 47 sections — architecture, full DB schema, provider layer, RAG pipeline, security/threat model, OCI deployment, CI/CD, expert review, scored rubric, production gates |
| `ai-web-ui-plan/END_USER_REVIEW.md` | 4-persona end-user walkthrough with 14 findings and release recommendation |
| `ai-workspace/` | **A running implementation** of the MVP core (zero npm dependencies): BYOK encrypted key vault, SSE streaming chat, PDF/text RAG with page citations, vision gating, GitHub repo Q&A, feedback + triage, usage/cost tracking — see `ai-workspace/BUILD_REVIEW.md` for the acceptance battery (12/12 green) and open production gaps |

## Quick start (the app)

```bash
cd ai-workspace
node server.js        # → http://localhost:3000 (Node 20, no npm install)
```

Then add an OpenRouter/Groq key in Provider settings (or complete the first-run wizard), chat, upload `ai-workspace/tests/meridian-q3.pdf`, and ask about it.

## Document map

- Plan §1–§9: goals, personas, phasing, architecture, stack, design system, repo structure, schema
- Plan §10–§15: providers, capability registry, reliability, key security, chat UI, prompt governance
- Plan §16–§24: documents/RAG, images, GitHub connector, feedback, workspaces, templates, usage, privacy
- Plan §25–§34: threat model, API routes, jobs, OCI deployment, IaC, Docker, CI/CD, secrets, observability, backup/rollback
- Plan §35–§47: testing, journeys, checklists, DoD, ADRs, docs, expert review, gap analysis, rubric, readiness gates, roadmap, changelog

## Status

- Plan: v1.1 complete (end-user fixes absorbed — §47 changelog)
- Demo build: accepted as reference implementation; production blockers listed in `ai-workspace/BUILD_REVIEW.md` §3
- GitHub push: pending — repository needs a remote URL + credentials (none present in this environment)
