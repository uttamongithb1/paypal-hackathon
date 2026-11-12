# AI agent specification

The agent helps a shopper discover, compare and prepare a purchase. It does not move money.

## Runtime

- Entry: `POST /api/v1/chat/stream` (SSE).
- Orchestrator: `app/server/agent/orchestrator.mjs`.
- Tool registry: `app/server/agent/tools.mjs`.
- Runtime contract: `contracts/agent_tools.json`, loaded by `app/server/agent/toolBridge.mjs`.
- Live provider client: `app/server/agent/llm.mjs` (OpenAI-compatible chat completions).
- Hosted model: Groq `openai/gpt-oss-120b`. Offline/CI path: deterministic planner.

Both profiles use the same closed registry, argument validation, ownership rules and SSE frames.
`message.end.usage.profile` reports `live` or `deterministic-fallback`; fallback reason/detail is
included when the model is unavailable.

## Safety boundary

There is **no tool** to create, approve, capture, authorise or refund a payment, and no generic
HTTP/shell/eval/file tool. Payment is a separate human-approved HTTP flow. Identity is resolved from
the server session; the model never supplies `userId` or `sessionId`.

Additional guards:

- arguments validated against the contract before execution;
- product/price/stock claims must come from tool results;
- model-invented prices are replaced with verified catalogue figures;
- prompt-injection and off-topic requests are refused or redirected;
- cart/quote owner keys normalise guests to session scope, matching the HTTP cart;
- bounded iterations/timeouts prevent runaway tool loops.

## Tools

| Tool | Group | Purpose |
|---|---|---|
| `search_products` | read | Grounded catalogue search with requirement filters |
| `get_product` | read | Full product detail |
| `compare_products` | read | Side-by-side comparison of candidate products |
| `check_availability` | read | Live available-to-sell stock |
| `view_cart` | read | Current cart summary |
| `get_quote_estimate` | read | Server-recomputed subtotal/shipping/tax estimate |
| `add_to_cart` | write | Add a product/quantity |
| `update_cart_item` | write | Set absolute quantity |
| `remove_cart_item` | write | Remove line (confirmation required) |
| `clear_cart` | write | Clear cart (confirmation required) |
| `prepare_checkout` | side-effecting | Create quote + draft order/holds; stops before PayPal approval |
| `answer_policy` | read | Canonical shipping/returns/warranty/tax/payment/privacy policy |
| `remember_preference` | write | Persist shopping preference |
| `set_requirement` | internal | Structured requirement update driven by extraction, not offered to the model |

The contract currently defines 14 tools; 13 are model-facing and `set_requirement` is internal.

## Limits

Defaults come from `contracts/agent_tools.json` and can be overridden by env:

| Limit | Default |
|---|---:|
| Max tool iterations | 6 |
| Per-tool timeout | 8000 ms |
| Turn timeout | 45000 ms |
| Max products returned | 10 |
| Max compared products | 4 |
| Max cart lines | 20 |
| Max line quantity | 10 |

## Requirement extraction

Free text is converted into a structured requirement: category, budget, use case, quantity and
category-specific attributes (e.g. RAM/storage for laptops). Revisions increment a revision number.
Under-specified requests trigger a targeted clarification instead of guessing. Candidate ids and last
prices are restored between turns so references like “the cheapest” or “the second one” resolve.

## SSE frames

| Event | Meaning |
|---|---|
| `message.start` | Turn/message id |
| `tool.activity` | Tool started/done/error with duration |
| `ui.component` | Server-authored component payload (cards, comparison, cart, checkout) |
| `message.delta` | Incremental assistant text |
| `message.end` | Final text, usage/profile, quick replies |
| `error` | Safe error payload |

The model never emits raw UI JSON. Components are built by server code from tool results.

## Configuration

```dotenv
FEATURE_LIVE_LLM=true|false
LLM_PROVIDER=groq|openai-compat
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=<secret>
LLM_MODEL=openai/gpt-oss-120b
LLM_TEMPERATURE=0.2
LLM_MAX_ITERATIONS=6
LLM_PER_CALL_TIMEOUT_MS=8000
LLM_TURN_TIMEOUT_MS=45000
```

With `FEATURE_LIVE_LLM=false`, or when the live provider fails, the deterministic planner serves the
turn. The storefront labels the active profile so a degraded demo is never presented as live AI.

## Evaluation

`app/tests/evals/live-agent.test.mjs` drives a scripted OpenAI-compatible provider to exercise the live
tool-calling loop without network cost. Integration tests cover grounding, prompt injection, payment
refusal, cart ownership, SSE reliability and fallback behaviour. Run with `npm test` / `npm run verify`.
