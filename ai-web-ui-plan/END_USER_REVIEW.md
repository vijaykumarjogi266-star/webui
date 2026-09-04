# End-User Review — AI Workspace App
**Reviewed artifact:** `AI_WEB_UI_BUILD_PLAN.md` v1.0 (build plan + UX spec)
**Review method:** Heuristic walkthrough of every specified screen and user journey, role-played against the four product personas, scoring flows the way a real first-time user would experience them — not the way an engineer would.
**Date:** 2026-09-03 · **Reviewer stance:** end user (4 personas), not builder

---

## 0. Executive verdict

> *"On paper this is a serious product. But the first 10 minutes assume I already know things most users don't — what an API key is, where to buy one, what a workspace is. Fix the cold-start and this becomes genuinely easy; don't, and non-technical users bounce at step 3 of the wizard."*

| Persona | Would complete setup unaided? | Satisfaction | Verdict |
|---|---|---|---|
| Priya — non-technical business user | ⚠️ Only with a human guide or IT hand-holding | 3.5 / 5 | Usable, but the BYOK cliff is real |
| Arjun — developer | ✅ Yes | 4.5 / 5 | Strong; a few power-user gaps |
| Meera — admin | ⚠️ Partially — she can't actually onboard her team in MVP | 3 / 5 | Triage + health are good; team management is missing |
| Daniel — security-conscious | ✅ Yes, after reading 2 pages | 4 / 5 | Best-in-class transparency; two rights gaps |

**Bottom line:** 7 findings worth fixing before launch (3 High), all cheap relative to what's already planned. None invalidate the architecture; most are copy, defaults, and one missing spec.

---

## 1. Persona walkthroughs

### 1.1 Priya — non-technical business user

**Journey attempted:** sign up → add key → chat → ask a PDF a question.

**What works for her**
- ✅ First-run wizard exists and is skippable with reminders (§9 spec) — exactly right for her.
- ✅ Microcopy is plain and calm. *"We couldn't use this API key. Check that it's correct, active, and has credit…"* — she can act on that (§7.5).
- ✅ Vision warning fires *before* she can send (§18) — she never experiences a mysterious failure.
- ✅ PDF indexing message lets her keep working (§7.5) — no staring at a spinner.
- ✅ Citations are clickable chips that open the PDF at the right page (§16.5) — this is the trust-maker for her.
- ✅ OCR defaults include Hindi (§16.3) — her contracts are often bilingual; nobody asked, huge win.

**What hurts**

| # | Moment | Problem (in her words) |
|---|---|---|
| U1 | Wizard step 3 | *"Add your OpenRouter API key."* — **"What's an API key? Where do I get one? Do I need a credit card?"** The plan has no 'How to get a key' guided step (link + screenshots + what-it-costs explainer). For her, setup fails here, not in our app. |
| U2 | Same step | She has to leave the app, register at OpenRouter, add billing there, copy a long string back. The S1 "under 5 minutes" success metric (§2.2) **does not include that external signup** — as written, it's unmeasurable and probably unachievable for her. |
| U3 | Model selector | Even filtered, a model list is intimidating. She doesn't know what "context window" or "reasoning" means. There's no single **"Just pick for me"** default mode that hides the selector entirely until she asks for control. |
| U4 | First test message | The wizard's "send first test message" costs her money (tiny, but real) on a provider she just paid to set up. Nobody tells her. One sentence would fix it. |
| U5 | Usage page | Tokens, Mtok, estimates — accountant-brain overload. She wants one number: **"≈ ₹ spent this month"** and a red line she set herself. Currency display is mentioned exactly once ("₹ equivalent of $0.50") and never specced. |
| U6 | Mobile | She'll mostly use her phone. The plan says "responsive" but never says how a cited PDF opens on a 360px screen next to the chat. Pin-citation-on-top-of-chat needs a design. |
| U7 | Jargon | "Workspace" is engineer-speak. She'll accept it if the first one is auto-named "My workspace" with a one-line explainer ("A workspace keeps one project's chats, files and keys together"). |

**Priya's score: 3.5/5.** She succeeds only if IT hands her a key and a model choice. That's a solvable product gap — see F1/F2 below.

---

### 1.2 Arjun — developer user

**Journey attempted:** add Groq key → connect GitHub → index a repo → ask about code → review a file → manage templates.

**What works for him**
- ✅ Groq latency-first UX with honest "cost not priced" labeling (§23 honesty rule) — he'll trust the Usage page because of exactly that.
- ✅ GitHub connector with file-path + line-range citations (§19.2) — the right granularity for code answers.
- ✅ Secret-skipped notice (*"3 files skipped (possible secrets)"*) — he'll respect a tool that doesn't ship his `.env` to a model.
- ✅ Conversation export as Markdown/JSON (§14.2) — he'll script around it.
- ✅ Capability badges + cost hints on the model picker (§11) — power without clutter.
- ✅ Advanced panel collapsed, one click away (§14.1) — progressive disclosure done right.

**What hurts**

| # | Moment | Problem |
|---|---|---|
| U8 | Automation | Everything is cookie-session. There's **no personal API token** to hit `/api/chat/stream` from his terminal/scripts. The API reference exists (§41) but there's no machine auth story. Developers adopt tools they can script. |
| U9 | Templates | Prompt templates are Phase 2, but his persona explicitly lists them as core needs — and the API is "MVP-ready" per §22. Shipping the backend without the UI leaves his #2 ask visibly half-done. |
| U10 | Code review output | Review findings arrive as chat prose. He wants severity-grouped findings with file:line anchors he can click through to the file preview. Chat-prose-only will feel like a toy next to real review tools. |
| U11 | Model picker | No pinning/favorites. He uses 3 models daily; scrolling OpenRouter's catalog every time is friction. |
| U12 | Keyboard | ⌘K and ⌘Enter only. He'd expect: navigate conversations ↑↓, retry R, focus composer `/`. Cheap, high perceived quality. |

**Arjun's score: 4.5/5.** Day-one happy; U8–U9 decide whether he stays.

---

### 1.3 Meera — admin user

**Journey attempted:** set up the app for her 40-person team → manage providers → watch usage → triage feedback.

**What works for her**
- ✅ Feedback triage page is genuinely complete: filters, assignment, history, export (§20.5).
- ✅ Admin health page with queue depth, DLQ, provider success rates (§33) — she can answer "is it down or is it OpenRouter?" herself.
- ✅ Global provider kill-switch + per-user hard limits (§23) — real control levers.
- ✅ Audit logs with a UI route (§26) — she can answer "who changed what" without SSH.
- ✅ Per-env isolation + budget alarms (§28.4) — her CFO conversation is covered.

**What hurts — including the review's biggest finding**

| # | Moment | Problem |
|---|---|---|
| U13 | Day 1 | **She cannot onboard her team.** Workspace invites/sharing is Phase 2 (§21), so all 40 people create personal accounts and personal workspaces. There is no invite flow, no shared workspace, no SSO until Phase 2 — yet "Admin manages a 40-person team" is her defining story. The persona and the phasing contradict each other. |
| U14 | Day 1 | The schema has `workspace_members` and roles — the *machinery* for teams exists in MVP; only the UI is missing. That makes this a cheap fix being deferred for no architectural reason. |
| U15 | Keys for everyone | `.env.example` defines server-level provider keys (`OPENROUTER_API_KEY` etc.) — but **no section of the plan specifies what they do**. Can she configure an org-wide key so her users skip BYOK entirely? Unspecified. This is exactly the "IT team distributes one key" scenario her company needs (and Priya's rescue — see F1). |
| U16 | Critical feedback | "Notify admins immediately" — via what? No in-app notification center exists anywhere in the 19 screens (§8). Email is Phase 2. So "immediately" currently means: whenever she happens to open the triage page. |
| U17 | Team usage | "Totals by user/workspace; export" exists (§23) but no admin usage screen appears in the page list. Is it inside Admin settings? Unspecified screens don't get built. |

**Meera's score: 3/5.** Strong ops tooling, but as specified she ships a single-player app to a team. U13–U15 must be reconciled before MVP sign-off.

---

### 1.4 Daniel — security-conscious user

**Journey attempted:** read privacy page → verify encryption claims → upload a client PDF → later, delete everything.

**What works for him**
- ✅ Data Transparency panel states what's stored, where, and what leaves the boundary *when* (§24.1) — the single most trust-building feature in the product.
- ✅ "Nothing is sent until you ask a question about it" (§24.4) — exactly the guarantee he looks for.
- ✅ Provider data-retention disclosure table (§24.3) — almost nobody ships this.
- ✅ Delete-cascade with a verifiable completion event (§24.3) — deletion he can audit.
- ✅ EXIF/GPS stripping by default (§18) — detail most apps miss.
- ✅ Threat model is public-material quality; he'd read it and nod (§25).

**What hurts**

| # | Moment | Problem |
|---|---|---|
| U18 | Provider table | OpenRouter **routes requests to many underlying model backends**, each with its own data policy. A per-provider table that doesn't mention per-model routing is incomplete for his decision-making. Needs a "routes to" disclosure or at least a pointer to OpenRouter's model-by-model policies. |
| U19 | Account deletion | Self-serve account deletion is Phase 2; MVP is "admin-assisted" (§24.3). For a privacy-first persona — and under DPDP — "ask the admin to delete me" is the wrong default even in MVP. |
| U20 | Sessions | No self-serve session list/revoke in MVP (§42 finding). He shares a laptop; he wants "sign out other devices" on day one. |
| U21 | Outbound proof | He'll ask: "prove my PDF wasn't sent anywhere except when I asked." Usage logs record calls but not content (correct), yet there's no user-visible *data-movement timeline* ("your file left for OpenRouter at 14:02 for message #7"). Cheap to derive from existing logs; huge trust return. |

**Daniel's score: 4/5.** Genuinely impressed; U19 is the one that would keep him from recommending it.

---

## 2. Consolidated findings

Severity: **High** = fix before MVP launch · **Med** = fix before GA/Phase-2 kickoff · **Low** = backlog.

| ID | Finding | Personas | Sev | Recommendation | Effort |
|---|---|---|---|---|---|
| F1 | No org/admin-provisioned provider keys — `.env` server keys exist but are unspecified; BYOK is the *only* path | Priya, Meera | **High** | Spec an admin-configurable "workspace key pool": users without personal keys fall back to the workspace's shared key (metered per user). Rescues every non-technical user and the team rollout. | M |
| F2 | Wizard has no "how to get an API key" step; S1 metric ignores external signup | Priya | **High** | Add guided step with deep links + what-you'll-pay explainer; redefine S1 as *"from wizard start to first streamed reply, given a key in hand"*, and add S1b for key-acquisition time. | S |
| F3 | No team invites/shared workspaces in MVP while admin persona requires teams | Meera | **High** | Pull a minimal invite flow (email invite → member role) into MVP; schema already supports it. Defer fine-grained sharing, not membership. | M |
| F4 | No "My feedback" tracking view for submitters; status notifications have no delivery surface | Meera, all | **Med** | Add user-scoped "My feedback" list (status + history) to the Feedback page; make it the in-app notification surface until a real center exists. | S |
| F5 | Dashboard screen content unspecified | All | **Med** | Spec it: recent conversations, files being indexed, setup checklist reminders, usage this month, one-click resume. Empty dashboards read as dead product. | S |
| F6 | Cost UX: no currency setting, no plain monthly ₹ number, wizard test message costs unannounced | Priya | **Med** | Workspace currency setting (INR default for ap-mumbai-1 deployments); Usage hero metric in currency; one-line cost notice on wizard test message. | S |
| F7 | No machine access (personal API tokens) despite published API reference | Arjun | **Med** | MVP-lite: scoped, revocable PATs stored like other secrets (§13 pattern). Else move API reference to Phase 2 to avoid advertising what can't be used. | M |
| F8 | Self-serve account deletion + session revoke deferred past MVP | Daniel | **Med** | Account deletion to MVP (30-day grace already designed); session list/revoke is one screen on existing `sessions` table. | S–M |
| F9 | Template UI deferred while templates are a named developer need and backend ships in MVP | Arjun | **Med** | Either ship the composer template picker (cheap, API exists) or re-scope the persona claim. Recommend: ship the picker, defer library management. | S |
| F10 | Model picker: no pinning/favorites; no "just pick for me" mode | Priya, Arjun | **Low** | Pin up to 3 models; auto-mode that hides the selector for users who never open it. | S |
| F11 | OpenRouter provider table omits per-model backend routing disclosure | Daniel | **Low** | Add "routes to" column sourced from OpenRouter docs, quarterly review cadence already exists. | S |
| F12 | Mobile: citation→PDF-viewer behavior on small screens undesigned | Priya | **Low** | Design call: citation tap opens PDF in overlay sheet with page pinned; back returns to chat position. Add to §7 mobile specs. | S |
| F13 | Code review output is prose-only | Arjun | **Low** | Phase 2: structured findings (severity, file:line links). MVP acceptable if findings cite exact paths/lines. | M (P2) |
| F14 | 12-step wizard feels long even when skippable | Priya | **Low** | Group into 3 screens (Account → Provider → Try it), optional steps as a checklist on the finish screen. | S |

Legend: S ≤ 2 days · M ≤ 1 week.

---

## 3. Success-metric reality check (as experienced by users)

| Metric | End-user assessment |
|---|---|
| S1 first message < 5 min | ⚠️ At risk for BYOK cold-start (F2). Achievable *with* F1's shared-key path — Priya's realistic path to sub-5-minute. |
| S2 PDF without help | ✅ Pipeline, states, and microcopy support it; OCR consent prompt is well judged. |
| S6 feedback < 30s | ✅ Form design supports it; paste-a-screenshot is the winning detail. |
| S7 first token < 3s | ✅ Credible; users never see infrastructure, only the typing indicator — keep the "thinking…" skeleton under 1s. |
| S12/S13 reliability | Neutral to users *if* the provider-down copy is as good as the rest; the fallback toggle should default ON with a one-time consent instead of being opt-in per conversation (nobody re-toggles per chat). |

---

## 4. What users will love if it survives implementation

1. Citations that open the actual PDF page — the single most demo-able trust feature.
2. The honest Usage page ("usage tracked, cost not priced") — rare integrity, builds loyalty.
3. *"Groq can't do PDF search — here's how to enable it"* guidance instead of a dead button.
4. Secret-skipped transparency in GitHub indexing.
5. The Data Transparency panel — Daniel will screenshot it; it's a sales asset.

## 5. Release recommendation

**Conditional GO for MVP** — contingent on F1, F2, F3 (all High, all feasible within the existing M2–M4 milestones without re-architecture), plus a commitment to F4–F6 before launch. Everything else slots into Phase 2 as already scheduled.

The plan built an excellent engine; this review is mostly about the on-ramp. Fix the cold-start, give the admin her team, and the four personas all finish their journeys.

*— End of end-user review.*
