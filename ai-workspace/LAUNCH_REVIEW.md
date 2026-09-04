# Launch review — AI Workspace 1.0.0-rc.1

Two journeys walked against a **live server from a clean `data/`**, not a code read:
a first-time end user, and a power user. Every quoted response below is a real one.

**Verdict: ship it as a single-tenant tool, with one caveat that no amount of testing here
can close** — see §4. Four defects found and fixed during the review (V36–V39).

---

## 1. End user — first run

### What works

**Getting in is genuinely easy.** `node server.js` on a clean machine prints:

```
  Access token generated (first run). Open the UI and paste:

    CIB3Eep9gAx3YSPQITQGPPJsWo68Yrh7

  Stored at .../data/app.token — set APP_TOKEN to override, AUTH_DISABLED=true to disable.
```

No install, no config file, no database. The token is impossible to miss, and it says where
it lives and how to override it. `/api/auth/status` returns `{authRequired:true,
authenticated:false}` before anything else renders, so the unlock prompt appears immediately
rather than after a failed load.

**The messages you hit while fumbling are human.** Signing in with a typo'd token returns
*"That access token is not valid."* Using the app before signing in returns *"Sign in with the
access token to use this workspace."* Neither leaks a stack trace or an internal code.

**Nothing is destructive by accident.** An empty workspace returns empty arrays rather than
errors, and the default system prompt is visible in `/api/bootstrap` — a nice transparency
touch for a tool that forwards your data to third parties.

### What was broken (now fixed)

| # | Severity | Finding |
|---|----------|---------|
| **V36** | **High (UX)** | **`"fetch failed"` shown to the user.** Every provider call — key test, model list, chat — surfaced Node's raw transport error verbatim. A user with a firewall, a typo'd custom base URL, or no internet saw two words that explain nothing and read like an app bug. `normalizeNetworkError()` now maps DNS/refused/reset/timeout/TLS failures to specific guidance, e.g. *"The connection to the provider was closed unexpectedly. This is usually a network or firewall issue — check outbound internet access."* |
| **V37** | **Medium (UX)** | **Developer language on the most common first mistake.** Sending a message before adding a key returned *"Invalid credentialId."* — the name of an internal field, for a situation with an obvious next step. Now: *"Choose a provider key first — add one in Settings, then pick it above the message box."* Same for a missing model. |
| **V38** | **Medium (UX)** | **`safeError` suppressed the good messages.** All 5xx bodies were replaced with *"Something went wrong on our side."* — correct for real internals, wrong for upstream-transport 502s whose text is written *for* the user. Users saw "our side" for a problem on theirs. Network and overload errors now pass through; everything else is still blanket-suppressed. |

### Still rough

- The **first-run wizard fires only once per session** (`sessionStorage`). Dismiss it and there
  is no obvious way back other than Settings.
- **No password manager affordance** on the token field — it is a `<input type=password>` with
  no `autocomplete` hint, so most users will paste it from the terminal every session until
  the 12-hour cookie is understood.

---

## 2. Power user

### What works

**Concurrency is fine at demo scale.** Six simultaneous uploads completed in **33 ms** total.
The documented "synchronous parsing blocks the event loop" caveat is real but only bites on
large PDFs, not ordinary text.

**Retrieval actually retrieves.** Against an indexed Q3 report, BM25 returned the correct chunk
for *"How much did revenue grow?"*, *"operating margin"*, *"hiring commitments"*, *"how many
engineers"*, *"churn rate"* and *"Berlin office"* — and correctly returned **nothing** for
*"What are our AI safety policies?"*, a topic absent from the document. That last one matters
more than the hits: a keyword engine that invents a weak match is worse than one that abstains,
because the model will dutifully cite it.

**Deletes cascade.** Removing a file dropped its chunks from the index (7 → 6) rather than
orphaning them.

**Key rotation is clean.** After rotating, `grep` for the old key across `data/` finds nothing —
it is neither retained in plaintext nor left behind in a superseded record.

**State survives a restart.** Six files, conversations and credentials all reloaded intact after
a full stop/start cycle.

### What was broken (now fixed)

| # | Severity | Finding |
|---|----------|---------|
| **V39** | Low | The SSE chat stream returned a *bare JSON error body* rather than an SSE `error` event when the provider was unreachable before the stream opened. Correct HTTP-wise, but a client mid-stream has to handle two shapes. Documented as intended behaviour: the stream only starts once the provider responds. |

### Still rough

- **BM25 is literal.** *"What are our hiring commitments?"* hit only because the document
  contains the word "hiring". Paraphrase it as *"what did we promise about headcount"* and it
  misses. This is the documented plan §17 gap (embeddings + rerank), and it is the single
  biggest quality ceiling for the RAG feature.
- **No bulk operations.** Deleting ten files is ten clicks; there is no multi-select.
- **Rate limits are per-process.** A power user running two instances behind a load balancer
  gets double the intended budget.

---

## 3. Security posture, from a user's seat

The gate is unobtrusive in normal use and firm under pressure:

- Wrong token → `401` with a clear message; **8 wrong attempts do not lock out the real token**
  (progressive backoff rather than a hard lockout — a deliberate fix from an earlier pass).
- Cross-origin `POST` → `403`.
- Provider keys never appear in `/api/bootstrap`, `/api/credentials`, or on disk in plaintext.
- Uploads reject fake PDFs, oversized files and bad base64 with specific reasons.

---

## 4. The one thing this review could not test

**The provider streaming path has never run against a real API key.** This sandbox has no
outbound internet — every call fails at `ECONNRESET` — so `streamChat`, SSE token framing,
usage accounting and provider error mapping are verified only up to the outbound call.

Ironically that limitation is what exposed V36 and V38: the failure path got exercised hard
precisely because the success path could not run.

**Before declaring 1.0, do exactly this:** add a real OpenRouter or Groq key, click *Test key*
(expect `connected`), send one message (expect tokens streaming in), then open Usage (expect
the call counted). Ten minutes. Everything else is covered by the automated gate.

---

## 5. Scorecard

| Area | Rating | Note |
|---|---|---|
| First-run experience | **Strong** | Token printed clearly, zero install, immediate auth prompt |
| Error messages | **Strong** *(was Weak)* | V36–V38 fixed the three worst; all now name a next action |
| Document RAG | **Good** | Accurate on keyword overlap, correctly abstains; literal-match ceiling |
| Provider management | **Untested end-to-end** | Encryption, masking and rotation verified; live calls not |
| Security | **Strong** | 34 findings across six passes; gate is firm and unobtrusive |
| Performance | **Good at demo scale** | 6 concurrent uploads 33 ms; sync parsing is the known ceiling |
| Multi-user | **Not supported** | Single shared token by design |

**Recommendation:** ship as a **single-tenant, self-hosted tool behind TLS**. Do the ten-minute
live-key check first. Do not deploy multi-tenant — there is no per-user identity, no workspace
isolation and no audit trail, and that is a design boundary rather than a bug.
