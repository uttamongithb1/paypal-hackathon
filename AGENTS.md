# AGENTS.md — Operating Manual for the Coding Agent

You are building **ShopPilot AI** from the documentation set in this repository. This file is your contract. Read it fully before writing a line of code, and re-read §5 before touching anything in the payment path.

---

## 1. Read order (do this first, once)

1. `README.md` — what the product is and what "done" looks like.
2. `prd.md` — scope, requirements, acceptance criteria. Non-goals are as binding as goals.
3. `docs/architecture.md` — repo layout, layering, flows.
4. `docs/data_model.md` — every collection, index, invariant and state machine.
5. `docs/api_spec.md` — the REST + SSE contract you must implement exactly.
6. `docs/ai_agent_spec.md` — agent loop, prompt, tool schemas, guardrails, evals.
7. `docs/payments_paypal.md` — the money path. Read §4 (verification) twice.
8. `design_system.md` + `docs/ui_flows.md` — tokens, components, screens.
9. `docs/implementation_plan.md` + `docs/backlog.md` — what to build, in what order.

Then reply with the bootstrap answer described in `README.md` §2 (repo tree, starting milestone, contradictions found). **Do not write code in that first reply.**

---

## 2. Working agreement

* **One ticket at a time, in backlog order.** Start from `M0`/`FND-01`. Never begin a ticket whose `Depends on` is unfinished, and never work on two milestones in the same change set.
* **Announce the plan, then execute.** For each ticket: restate the acceptance criteria in your own words, list the files you will create/modify, then implement.
* **Small, reviewable commits.** One ticket per commit or per tight commit sequence. Commit message: `FND-04: shared money + order state modules` with the ticket id first.
* **Docs are code.** If behaviour changes, update `prd.md`, `docs/api_spec.md`, `docs/data_model.md`, `docs/analytics_spec.md` or `docs/payments_paypal.md` in the **same** commit. CI runs a drift check.
* **Ask only when the docs are silent.** If a decision is genuinely unspecified, choose the simplest option consistent with the PRD, implement it, and record the choice in `docs/decisions.md` with a `DEC-NN` id. Do not invent product scope.
* **Never fabricate progress.** Report what is implemented, what is tested, and what is stubbed, with file paths and the exact command you ran.

---

## 3. Repository conventions

```
apps/api     Express 5 + TypeScript. Layers: routes → controllers → services → repositories → models.
apps/web     Next.js 16 App Router + Tailwind v4. Server components by default; 'use client' only when needed.
packages/shared  Types, zod schemas, money, state machines, event names, policies. No I/O, no framework imports.
contracts/   openapi.yaml + agent_tools.json. Update with the spec docs.
scripts/     seed, reset, jobs, migrations, generators.
```

Hard rules:
* TypeScript `strict: true`; no `any` (use `unknown` + zod parse); no non-null assertions on data from the network or DB.
* No business logic in routes/controllers/React components — it belongs in services or `packages/shared`.
* No `Date.now()` in domain code — inject the clock (`services/clock.ts`) for testability.
* No floats in the money path — `number` minor units only, `assertIntegerMinor()` at boundaries.
* No direct `fetch` to PayPal or the LLM outside their dedicated clients.
* No raw SQL-like string building for Mongo queries; build filters through repositories.
* No `dangerouslySetInnerHTML`; no new UI library; extend `components/ui` instead.
* No new dependency without a note in the commit body explaining why the platform/standard library cannot do it.
* Server errors return the error catalogue shape `{ error: { code, message, details?, requestId } }` (`docs/api_spec.md` §9). Add new codes to that table.

---

## 4. Non-negotiable invariants (test each; never weaken)

1. **Prices and totals are computed server-side** from live DB data. Client-supplied prices/quantities are ignored (except quantity, which is validated).
2. **No product, price, stock, spec, tax or shipping figure may come from the language model.** UI renders structured tool results; the model only writes prose.
3. **The agent cannot move money.** No tool creates, authorises, captures or refunds a payment. Payment requires a user-authenticated HTTP call plus an explicit UI approval.
4. **`status: 'paid'` is written only by `paymentService.verifyCapture()`** after all of V1–V7 pass. `payment_failed → paid` is impossible; a new attempt must pass through `payment_processing`.
5. **Every external money operation is idempotent**: `Idempotency-Key` from the client, deterministic `PayPal-Request-Id` server-side, an advisory lock per order.
6. **Inventory never goes negative**; commits are atomic and conditional (`stock >= qty`); holds are soft and TTL-bound.
7. **One order → at most one capture.** Duplicate approval clicks, retries, webhook replays and concurrent requests must all converge on one paid order.
8. **Webhooks are verified, deduplicated, and never used to downgrade a paid order.** PayPal's record wins when our write was lost; ours never overrides PayPal's amount.
9. **No PII in analytics, logs, or client state**: no email/address/card data in `analytics_events.props`, no secrets/passwords/tokens in logs (redaction list is tested).
10. **Merchant data is tenant-scoped** in every query; cross-tenant access returns 404.
11. **Guests are first-class**: cart, chat and orders work without signing in, and signing in merges rather than resets.
12. **Accessibility is part of done**: keyboard-complete money path, visible focus, live-region-safe streaming, reduced motion respected.

If a requested change conflicts with any of these, stop and flag it instead of implementing it.

---

## 5. Payment-path protocol (extra care)

Before editing `paymentService.ts`, `quoteService.ts`, `inventoryService.ts`, the capture route, the webhook route, or `verifyCapture`:
1. Re-read `docs/payments_paypal.md` §4 and §6 and `docs/data_model.md` §3.
2. State which verification checks, idempotency guarantees and state transitions your change affects.
3. Add or update the corresponding test **first** (they are listed in `docs/testing_strategy.md` §3, items 1–23).
4. Run `pnpm test:integration && pnpm ledger:check` and paste the summary in your report.
5. Never bypass verification "temporarily", never mock PayPal inside production code paths, never add a `forcePaid` flag.

---

## 6. Definition of Done (every ticket)

- [ ] Acceptance criteria from `docs/backlog.md` satisfied, each with a test that fails before your change
- [ ] `pnpm verify` green (format, lint, typecheck, unit, integration, contract, evals)
- [ ] Negative cases covered (invalid input, provider error, concurrency where relevant)
- [ ] Docs updated if any contract changed (`api_spec`, `data_model`, `analytics_spec`, `payments_paypal`, `design_system`, `ui_flows`)
- [ ] New error codes added to `docs/api_spec.md` §9; new events to `docs/analytics_spec.md` §1
- [ ] No invariant from §4 broken (say so explicitly in the report)
- [ ] Report format: ticket id, files changed, commands run with results, what a reviewer should check, known gaps

---

## 7. Style guidance

* Small pure functions over large components. Prefer a `services/*.ts` module with a typed input/output over an inline block in a controller.
* Name things exactly as the docs do (`quoteHash`, `payment_attempts`, `requirementRevision`, `InventoryHold`). Do not invent synonyms.
* Comments explain **why**, never restate code. Reference the doc section: `// verify V4: amount match (payments_paypal.md §4)`.
* Errors: user-facing copy comes from `messages/en.json` and follows `design_system.md` §8; developer messages are precise and include the code.
* Tests describe behaviour: `it('refuses to mark an order paid when the captured amount differs')`.
* Prefer boring, readable code; no clever abstractions, no premature generic frameworks, no speculative config.

---

## 8. Prompt pack (copy-paste task prompts)

Use these verbatim patterns when driving yourself or another agent.

**Bootstrap**
> Read AGENTS.md, README.md, prd.md, docs/architecture.md, docs/data_model.md, docs/api_spec.md and docs/backlog.md. Do not write code. Reply with the repo tree, the milestone you will start with, and any contradictions you found.

**Milestone kickoff**
> Implement milestone M1 (Catalogue & identity) from docs/implementation_plan.md. Work ticket by ticket in backlog order, starting with CAT-01. After each ticket, run `pnpm verify` scoped to the affected packages, update the docs if a contract changed, and report ticket id, files, commands, results. Stop and ask only if a doc is silent on a decision.

**Ticket execution**
> Execute ticket CAT-03 from docs/backlog.md. Restate the acceptance criteria, list the files you will create or modify, then implement with tests. Do not touch unrelated files. Report against the Definition of Done in AGENTS.md §6.

**Money path change**
> Modify the capture flow to [X]. First restate which of V1–V7 verification checks and which idempotency guarantees are affected. Write the failing tests from docs/testing_strategy.md §3 first, then implement. Run `pnpm test:integration && pnpm ledger:check` and paste the summary.

**Agent/prompt change**
> Update the agent for [X]. Change `docs/ai_agent_spec.md` first (prompt or tool schema), then the code. Run `pnpm test:evals` against FakeLlm and paste the case-by-case report. Never add a tool that can move money.

**UI change**
> Implement the [screen] from docs/ui_flows.md §[n] using tokens and components from design_system.md. Include all state variants (loading/empty/error/disabled), keyboard support, reduced motion, light+dark verification, and an axe-clean test.

**Debugging**
> [Symptom]. Reproduce it with a failing test first. Check docs/payments_paypal.md §6 and docs/data_model.md §3 for the expected state. Report the root cause, the fix, the regression test, and whether any invariant was at risk.

---

## 9. Escalation triggers (stop and ask a human)

* A requirement in `prd.md` contradicts the API spec, data model or design system.
* A ticket appears to require a change to one of the §4 invariants.
* PayPal sandbox behaviour differs from `docs/payments_paypal.md` §6 (e.g. a new error code or a status you cannot map).
* A test cannot be written without mocking the very thing it is supposed to prove (e.g. "verification" mocked away).
* The build needs a new runtime/service (Redis, queue, object storage) not in `architecture.md`.
* Anything involving real (live) PayPal credentials, real customer data, or production deployments.

---

## 10. Quick reference card

| Need | Go to |
|---|---|
Money math, shipping, tax | `prd.md` §5.4.1, `docs/data_model.md` §2.9 |
Order statuses | `docs/data_model.md` §3.1 |
PayPal request/verify | `docs/payments_paypal.md` §3, §4 |
Failure → UI mapping | `docs/payments_paypal.md` §6 + `design_system.md` §8 |
Tool schemas | `contracts/agent_tools.json`, `docs/ai_agent_spec.md` §4 |
System prompt | `docs/ai_agent_spec.md` §3 |
SSE frames | `docs/api_spec.md` §7 |
Error codes | `docs/api_spec.md` §9 |
Tokens/components | `design_system.md` §2, §5 |
Screen specs | `docs/ui_flows.md` |
Events | `docs/analytics_spec.md` §1 |
Tests to never break | `docs/testing_strategy.md` §3 |
Env vars | `docs/env_setup.md` §4 |
What to build next | `docs/backlog.md` |
