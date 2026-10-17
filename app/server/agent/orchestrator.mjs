/**
 * Agent orchestrator.
 *
 * Two interchangeable brains behind one contract:
 *   • DeterministicPlanner (default, FEATURE_LIVE_LLM=false) — same system prompt, same closed tool
 *     registry, same SSE frames, built from templates over tool results. Runs with no API key, which
 *     makes the product demoable, testable and CI-friendly.
 *   • LiveLlmClient (FEATURE_LIVE_LLM=true) — an OpenAI-compatible tool-calling loop that shares the
 *     registry and guardrails; wiring is in runLiveTurn().
 *
 * Invariants (../AGENTS.md §4): no tool may move money, every factual claim comes from a tool result
 * in the same turn, and the model never re-orders ranked products or invents products.
 */
import { ApiError } from '../lib/errors.mjs';
import { formatMoney } from '../lib/money.mjs';
import { objectId } from '../lib/crypto.mjs';
import { CLARIFY_QUESTIONS, describeRequirement, extractRequirement, requirementChanged, requirementChips } from './requirement.mjs';
import * as components from './components.mjs';
import { FORBIDDEN_TOOLS, liveSystemPrompt } from './prompt.mjs';
import { compactToolResult, executableToolNames, parseToolArguments, toOpenAiTools, toolMenu } from './toolBridge.mjs';
import { LlmError } from './llm.mjs';
import env from '../config/env.mjs';
import logger from '../lib/logger.mjs';

const CARD_LIKE = /\b(?:\d[ -]?){13,19}\b/;
const PII_KEYS = /\b(cvv|cvc|social security|ssn|passport number|card number)\b/i;
const OFF_TOPIC = /\b(weather|forecast|temperature|news|politics|election|president|joke|story|poem|recipe|medical|diagnose|invest(ment)? advice|stock market|crypto|who won|homework|write (me )?(some )?code|debug my code)\b/i;
const PAY_FOR_ME = /(just|please|can you|could you|you)\s+(pay|buy|purchase|checkout)\b/i;
const AUTONOMOUS = /\b(for me|on my behalf|yourself|automatically|without me|by itself)\b/i;

const DISCOVER = /\b(i need|i want|i'd like|i would like|i'm looking for|i am looking for|looking for|searching for|shopping for|in the market for|help me (find|choose|pick)|recommend|suggest|find me|need (a|an|some|new|another)|want (a|an|some|new|another)|my budget|budget is)\b|\b(under|below|less than|no more than|max|up to|around)\s*\$?\s?\d/i;

// "add it", "add 2 of the cheapest", "put the second one in my cart" — a cart-ish target must follow.
export const ADD_TO_CART = /\b(add|put|throw|include)\b(?=[\s\S]{0,60}?\b(cart|basket|bag)\b)|\b(?:add|put|include|throw)\s+(?:it|that|this|these|those|the|one|two|three|\d+|cheapest|first|second|third|last)\b/i;

export const INTENTS = [
  { name: 'checkout', test: /\b(checkout|check out|place (the |my )?order|ready to (buy|order)|prepare (my |the )?order|i want to buy|buy now|go to payment)\b/i },
  { name: 'compare', test: /\b(compare|comparison|versus|\bvs\b|difference between|which is better)\b/i },
  // Cart writes are matched before cart reads, so "add 2 of the cheapest to my cart" is not a read.
  { name: 'cart_add', test: ADD_TO_CART },
  { name: 'cart_clear', test: /\b(clear|empty) (my |the )?cart\b/i },
  { name: 'cart_remove', test: /\b(remove|delete|drop|take out)\b/i },
  { name: 'cart_quantity', test: /\b(set|change|update)\b.{0,20}\bquantity\b|\bquantity\b.{0,10}\bto\b|\bmake it (\d+)\b/i },
  { name: 'cart_view', test: /\b(what('s| is|s)? in my cart|show (me )?(my |the )?cart|view (my )?cart|open (my |the )?cart|cart (summary|contents)|my cart)\b/i },
  { name: 'availability', test: /\b(in stock|available|still (have|selling)|sold out|out of stock)\b/i },
  { name: 'policy', test: /\b(shipping|delivery|returns?|refunds?|warrant(y|ies)|tax(es)?|payment methods?|data privacy|privacy policy|secure (checkout|payment))\b/i },
  // A fresh statement of need always means "search again", even when it mentions a spec word below.
  { name: 'discover', test: DISCOVER },
  { name: 'greeting', test: /^\s*(hi|hey|hello|good (morning|afternoon|evening)|yo)\b/i },
  { name: 'followup', test: /\b(does it|do they|is it|is there|how much|what about|how long|how many|can i|can it|will it|battery|weight|screen|cpu|processor|gpu|upgrade|keyboard|camera|ports?|ram|storage|noise)\b/i }
];

/**
 * @param {string} message
 * @param {{ candidateIds?: string[], requirement?: object }} [ctx]
 * Spec words ("ram", "storage", "battery") only mean "follow-up question" once products are on screen.
 */
export const detectIntent = (message, ctx = {}) => {
  for (const intent of INTENTS) {
    if (intent.name === 'followup' && !ctx.candidateIds?.length) continue;
    if (intent.test.test(message)) return intent.name;
  }
  return 'discover';
};

const titleCase = (value) => String(value ?? '').replace(/(^|\s)\w/g, (c) => c.toUpperCase());

/** Resolve "the second one", "the cheapest", "the first", or a title/brand mention. */
export function resolveProductReference(message, candidates, { catalogue }) {
  if (!candidates?.length) return null;
  const lower = String(message).toLowerCase();
  const ordinal = /\b(first|1st|second|2nd|third|3rd|fourth|4th|last)\b/.exec(lower);
  const indexWord = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, last: candidates.length - 1 };
  if (ordinal) return catalogue.getRaw(candidates[indexWord[ordinal[1]]] ?? candidates[0]);
  const digit = /\b(?:option|number|#)\s*(\d)\b/.exec(lower);
  if (digit) return catalogue.getRaw(candidates[Number(digit[1]) - 1] ?? candidates[0]);
  if (/\b(cheapest|least expensive|budget one)\b/.test(lower)) {
    return candidates
      .map((id) => catalogue.getRaw(id))
      .filter(Boolean)
      .sort((a, b) => a.priceMinor - b.priceMinor)[0];
  }
  if (/\b(best|top|fastest|most powerful|best rated)\b/.test(lower)) {
    return candidates.map((id) => catalogue.getRaw(id)).filter(Boolean).sort((a, b) => b.ratingAvg - a.ratingAvg)[0];
  }
  if (/\bit\b|\bthat one\b|\bthis one\b/.test(lower) && candidates.length) return catalogue.getRaw(candidates[0]);
  for (const id of candidates) {
    const product = catalogue.getRaw(id);
    if (!product) continue;
    const brand = product.brand.toLowerCase();
    const titleWords = product.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (lower.includes(brand) || product.slug.includes(lower.replace(/\s+/g, '-'))) return product;
    if (titleWords.filter((w) => lower.includes(w)).length >= 2) return product;
  }
  return candidates.length ? catalogue.getRaw(candidates[0]) : null;
}

const parseQuantityFrom = (message) => {
  const wordNumbers = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1 };
  const match = /\b(?:add|buy|get|want|need|order|set|quantity to|make it)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a|an)\b/i.exec(message);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  return wordNumbers[raw] ?? Number(raw) ?? null;
};

/**
 * A one-line, human-actionable summary of a model failure. Never includes the API key: only the
 * HTTP status and the provider's error text, which is what tells you whether the model name is
 * wrong, the base URL is wrong, or the key was rejected.
 */
export function describeLlmFailure(error) {
  const status = error?.status ? `HTTP ${error.status}` : null;
  let providerMessage = null;
  const raw = error?.details?.body;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      providerMessage = parsed?.error?.message ?? parsed?.message ?? null;
    } catch {
      providerMessage = raw.slice(0, 160);
    }
  }
  return [status, providerMessage].filter(Boolean).join(' · ').slice(0, 300) || null;
}

export class Orchestrator {
  constructor(deps) {
    this.deps = deps; // { store, session, catalogue, cart, quote, order, payment, inventory, analytics, tools, logger }
  }

  // ── Turn entry point ─────────────────────────────────────────────────────
  async *runTurn({ auth, message, clientMessageId = null, requestId }) {
    const started = Date.now();
    const session = this.deps.session.byId(auth.session._id) ?? auth.session;
    const user = auth.user;
    const messageId = `m_${objectId()}`;
    const ctx = {
      session,
      user,
      requestId,
      requirement: session.chat?.requirement ?? null,
      // Restored so references like "the second one" or "the cheapest" survive between turns.
      candidateIds: session.chat?.lastCandidateProductIds ?? [],
      lastPrices: session.chat?.lastPrices ?? {},
      confirmed: false
    };

    const emit = (event, data) => ({ event, data });
    yield emit('message.start', { messageId, clientMessageId, at: new Date().toISOString() });

    this.deps.store.collection('chat_messages').insert({
      sessionId: session._id,
      userId: user?._id,
      role: 'user',
      content: message,
      clientMessageId,
      requirementRevision: session.chat?.requirementRevision ?? 0
    });

    const chat = this.deps.store.collection('chat_messages');
    this.deps.analytics.emit('chat_message_sent', {
      sessionId: session._id,
      userId: user?._id,
      props: { turnIndex: session.chat?.messageCount ?? 0, textLength: message.length, entryPoint: 'chat' }
    });

    // ── Guardrails ────────────────────────────────────────────────────────
    const guard = this.screenMessage(message);
    if (guard.hit) {
      this.deps.analytics.emit('guardrail_triggered', { sessionId: session._id, userId: user?._id, props: { kind: guard.kind } });
      const text = guard.reply;
      yield emit('message.delta', { messageId, text });
      yield emit('message.end', this.endPayload({ messageId, text, ctx, quickReplies: ['Show me laptops', 'Show me phones'], started }));
      this.persistAssistant({ session, user, messageId, text, toolCalls: [], components: [], ctx, stopped: false });
      return;
    }

    // ── Requirement extraction + revision ─────────────────────────────────
    const schemas = Object.fromEntries(
      this.deps.store.collection('categories').find({}).map((c) => [c.slug, c.attributeSchema])
    );
    const extraction = extractRequirement(message, { previous: ctx.requirement, attributeSchemas: schemas });
    const requirement = extraction.requirement;
    const changed = requirementChanged(ctx.requirement, requirement);
    if (changed) {
      requirement.revision = (ctx.requirement?.revision ?? 0) + 1;
      ctx.requirementDescription = describeRequirement(requirement);
      this.deps.analytics.emit('requirement_updated', { sessionId: session._id, userId: user?._id, props: { revision: requirement.revision } });
    }
    ctx.requirement = requirement;
    ctx.requirementChanged = changed;

    const intent = detectIntent(message, ctx);
    ctx.intent = intent;

    // Prior turn asked a clarifying question → interpret the answer.
    const pendingClarification = session.chat?.pendingClarification;
    if (pendingClarification) {
      this.applyClarificationAnswer(pendingClarification, message, ctx);
    }

    // ── Live model path (FEATURE_LIVE_LLM=true) ───────────────────────────
    // The model drives tool selection through the SAME closed registry the deterministic planner
    // uses, so the "no tool can move money" invariant is identical for both brains.
    if (this.deps.llm?.enabled) {
      const live = yield* this.runLiveTurn({ messageId, message, ctx, session, user, started });
      if (live.completed) return;
      // The model was unavailable before anything was shown — degrade honestly, not silently.
      logger.warn('agent.live_fallback', { reason: live.reason, requestId });
      ctx.profile = 'deterministic-fallback';
      // Carry the reason out to the client. "It fell back" without "because the key was rejected"
      // is unactionable — this is the difference between a demo that can be debugged remotely and
      // one that needs someone with log access.
      ctx.fallbackReason = live.reason ?? 'LLM_UNAVAILABLE';
      if (live.detail) ctx.fallbackDetail = live.detail;
    }

    const plan = await this.plan({ intent, message, ctx });
    const toolCalls = [];
    const componentList = [];
    let cartUpdated = null;

    // ── Execute the plan ──────────────────────────────────────────────────
    if (plan.clarify) {
      this.deps.analytics.emit('chat_clarification_asked', {
        sessionId: session._id,
        userId: user?._id,
        props: { questionKind: plan.clarify.kind, optionsCount: plan.clarify.options.length }
      });
      yield emit('tool.activity', { id: 't0', tool: 'search_products', label: 'Checking the catalogue', status: 'running' });
      yield emit('tool.activity', { id: 't0', tool: 'search_products', status: 'done', durationMs: 120, resultSummary: { count: plan.clarify.poolSize ?? 0 } });
      const component = components.clarification({ ...plan.clarify, revision: requirement.revision });
      componentList.push(component);
      yield emit('ui.component', { messageId, component });
      yield emit('message.delta', { messageId, text: plan.text });
      yield emit('message.end', this.endPayload({ messageId, text: plan.text, ctx, quickReplies: plan.clarify.options, started }));
      this.persistAssistant({ session, user, messageId, text: plan.text, toolCalls: [{ name: 'clarify', args: { kind: plan.clarify.kind }, status: 'done', durationMs: 120 }], components: componentList, ctx, stopped: false });
      this.updateSessionChat(session, { pendingClarification: { kind: plan.clarify.kind, askedAt: new Date().toISOString() } });
      return;
    }

    for (const [index, step] of (plan.steps ?? []).entries()) {
      const toolId = `t${index + 1}`;
      yield emit('tool.activity', { id: toolId, tool: step.tool, label: this.deps.tools.tools[step.tool]?.label ?? step.tool, status: 'running' });
      const toolStarted = Date.now();
      const outcome = await this.deps.tools.call(step.tool, step.args, ctx);
      const durationMs = Date.now() - toolStarted;
      toolCalls.push({ name: step.tool, args: step.args, status: outcome.ok ? 'done' : 'error', durationMs, resultSummary: summariseResult(outcome) });
      yield emit('tool.activity', {
        id: toolId,
        tool: step.tool,
        status: outcome.ok ? 'done' : 'error',
        durationMs,
        resultSummary: summariseResult(outcome)
      });

      if (!outcome.ok) {
        const fallback = outcome.requiresConfirmation
          ? 'Just to be safe — should I remove that from your cart?'
          : plan.failureText?.(outcome.error) ?? this.defaultFailureText(outcome.error);
        yield emit('message.delta', { messageId, text: fallback });
        yield emit('message.end', this.endPayload({ messageId, text: fallback, ctx, quickReplies: ['Yes, remove it', 'Keep it'], started }));
        this.persistAssistant({ session, user, messageId, text: fallback, toolCalls, components: componentList, ctx, stopped: false });
        return;
      }

      for (const component of outcome.components ?? []) {
        componentList.push(component);
        yield emit('ui.component', { messageId, component });
      }
      if (outcome.cartUpdated) cartUpdated = outcome.cartUpdated;
      if (outcome.candidateIds) ctx.candidateIds = outcome.candidateIds;
      if (outcome.requirementPatch) ctx.requirement = { ...ctx.requirement, ...outcome.requirementPatch };
      ctx.lastOutcome = outcome;
      if (ctx.requirement) ctx.requirement.revision = ctx.requirement.revision ?? 0;
      ctx.toolResults = [...(ctx.toolResults ?? []), outcome.result];
    }

    // ── Compose the answer from tool results only ─────────────────────────
    const text = plan.compose(ctx, toolCalls);
    const safeText = this.sanitiseOutput(text);
    for (const chunk of chunkText(safeText)) {
      yield emit('message.delta', { messageId, text: chunk });
    }
    if (cartUpdated) yield emit('cart.updated', { cart: publicCart(cartUpdated) });

    const end = this.endPayload({ messageId, text: safeText, ctx, quickReplies: plan.quickReplies?.(ctx) ?? [], started });
    yield emit('message.end', end);
    this.persistAssistant({ session, user, messageId, text: safeText, toolCalls, components: componentList, ctx, stopped: false });

    this.deps.analytics.emit('agent_turn_completed', {
      sessionId: session._id,
      userId: user?._id,
      props: { toolCalls: toolCalls.length, iterations: toolCalls.length, durationMs: Date.now() - started, stopped: false, profile: ctx.profile ?? 'deterministic' }
    });

    if (ctx.candidateIds?.length) {
      // A comparison can span stores, so tag the event with every merchant involved. Tagging only
      // the first candidate's merchant made a genuine recommendation invisible on the other
      // merchants' dashboards (their "Agent recommendations shown" tile read 0 forever).
      const merchantIds = [...new Set(ctx.candidateIds
        .map((id) => this.deps.catalogue.getRaw(id)?.merchantId)
        .filter(Boolean))];
      this.deps.analytics.emit('recommendation_shown', {
        sessionId: session._id,
        userId: user?._id,
        merchantId: merchantIds[0],
        props: { productCount: ctx.candidateIds.length, revision: ctx.requirement?.revision ?? 0, merchantIds }
      });
    }
  }

  // ── Live model path ──────────────────────────────────────────────────────
  /**
   * Model-driven turn. The LLM picks tools; every call still goes through `tools.call`, the same
   * registry, the same guards. Bounded on three axes from contracts/agent_tools.json `limits`
   * (maxToolIterations · perToolTimeoutMs · turnTimeoutMs).
   *
   * Returns `{ completed }`. It is false ONLY when the model failed before producing anything the
   * shopper can see, which is what lets the caller fall back to the deterministic planner without
   * double-emitting. Once a tool frame has been shown the turn is finished here, honestly.
   */
  async *runLiveTurn({ messageId, message, ctx, session, user, started }) {
    const emit = (event, data) => ({ event, data });
    const deadline = started + env.llmTurnTimeoutMs;
    const controller = new AbortController();
    const remaining = () => Math.max(1500, Math.min(env.llmPerCallTimeoutMs, deadline - Date.now()));

    // Conversation memory: the previous turns, so "the second one" still resolves. The message
    // that started this turn is already persisted, so drop it and pass it explicitly below.
    const recent = this.deps.store.collection('chat_messages')
      .find({ sessionId: session._id }, { sort: { createdAt: -1 }, limit: 12 });
    const history = recent
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.messageId !== messageId)
      .reverse()
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: String(m.content ?? '').slice(0, 1200) }));

    const messages = [
      { role: 'system', content: liveSystemPrompt({ toolMenu: toolMenu() }) },
      ...history,
      { role: 'user', content: message }
    ];

    const tools = toOpenAiTools();
    const toolCalls = [];
    const componentList = [];
    const toolPayloads = [];
    let cartUpdated = null;
    let emitted = false;
    let text = '';
    let iterations = 0;
    let usage = null;
    let profile = 'live';
    let toolChoice = 'auto';
    let forcedToolCall = false;

    try {
      while (iterations < env.llmMaxIterations) {
        if (Date.now() > deadline) throw new LlmError('LLM_TURN_TIMEOUT', 'The turn exceeded its time budget.');
        iterations += 1;

        const response = await this.deps.llm.chat({
          messages,
          tools,
          toolChoice,
          signal: controller.signal,
          timeoutMs: remaining()
        });
        usage = response.usage ?? usage;

        if (!response.toolCalls.length) {
          // A product request answered without touching the catalogue is grounded in nothing. If
          // the shopper clearly asked for a product and the model has not searched, make it search
          // once rather than accept an answer we cannot stand behind. Exactly once: if it still
          // declines, its prose is taken (and still goes through the grounding check below).
          if (!forcedToolCall && looksLikeProductRequest(message)) {
            forcedToolCall = true;
            toolChoice = 'required';
            continue;
          }
          text = response.text;
          break;
        }
        toolChoice = 'auto';
        forcedToolCall = true; // a tool has now run; do not force again

        messages.push({
          role: 'assistant',
          // `null` is what OpenAI documents for an assistant message that only calls tools, but
          // several OpenAI-compatible gateways reject it on the FOLLOW-UP call (which is why the
          // turn died after the first tool ran, not before it). An empty string is accepted
          // everywhere and is semantically identical here.
          content: response.text || '',
          tool_calls: response.toolCalls.map((call) => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments }
          }))
        });

        for (const call of response.toolCalls) {
          const toolId = `t${toolCalls.length + 1}`;

          // A forbidden capability is not merely blocked by prompt — it is absent from the
          // registry. The model can still ASK, so the refusal is explicit and traced, which is
          // exactly the property the eval suite asserts.
          if (FORBIDDEN_TOOLS.includes(call.name) || !executableToolNames().includes(call.name)) {
            this.deps.analytics.emit('guardrail_triggered', {
              sessionId: session._id, userId: user?._id, props: { kind: 'forbidden_tool' }
            });
            // Shown to the shopper on purpose. A capability that does not exist is only a
            // trustworthy design if you can watch it refuse — the frame is the proof.
            yield emit('tool.activity', {
              id: toolId,
              tool: call.name,
              label: `Asked for “${call.name}”`,
              status: 'refused',
              durationMs: 0,
              resultSummary: { refused: true, reason: 'no_such_capability' }
            });
            emitted = true;
            toolCalls.push({ name: call.name, args: {}, status: 'refused', durationMs: 0, resultSummary: { refused: true } });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({
                ok: false,
                error: {
                  code: 'TOOL_NOT_AVAILABLE',
                  message: `There is no "${call.name}" tool. You cannot move money or act outside this store's catalogue. Tell the shopper plainly that you cannot do that and point them to the "Approve & Pay" button.`,
                  retryable: false
                }
              })
            });
            continue;
          }

          yield emit('tool.activity', {
            id: toolId, tool: call.name, label: this.deps.tools.tools[call.name]?.label ?? call.name, status: 'running'
          });
          emitted = true;

          const parsed = parseToolArguments(call.name, call.arguments);
          const toolStarted = Date.now();
          const outcome = parsed.ok
            ? await this.deps.tools.call(call.name, parsed.args, ctx)
            : { ok: false, error: parsed.error };
          const durationMs = Date.now() - toolStarted;

          toolCalls.push({
            name: call.name, args: parsed.args ?? {}, status: outcome.ok ? 'done' : 'error',
            durationMs, resultSummary: summariseResult(outcome)
          });
          yield emit('tool.activity', {
            id: toolId, tool: call.name, status: outcome.ok ? 'done' : 'error', durationMs, resultSummary: summariseResult(outcome)
          });

          if (outcome.ok) {
            for (const component of outcome.components ?? []) {
              componentList.push(component);
              yield emit('ui.component', { messageId, component });
            }
            if (outcome.cartUpdated) cartUpdated = outcome.cartUpdated;
            if (outcome.candidateIds) ctx.candidateIds = outcome.candidateIds;
            if (outcome.requirementPatch) ctx.requirement = { ...ctx.requirement, ...outcome.requirementPatch };
            ctx.lastOutcome = outcome;
            ctx.toolResults = [...(ctx.toolResults ?? []), outcome.result];
            toolPayloads.push(compactToolResult(call.name, outcome.result));
          }

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(compactToolResult(call.name, outcome.ok ? outcome.result : { error: outcome.error }))
          });
        }
      }

      // Iteration budget spent with tools still in flight: ask once for a closing summary, no tools.
      if (!text) {
        const closing = await this.deps.llm.chat({
          messages: [...messages, { role: 'user', content: 'Summarise what you found for the shopper in at most four short sentences. Do not call any more tools.' }],
          tools: [],
          signal: controller.signal,
          timeoutMs: remaining()
        });
        text = closing.text;
        profile = 'live-iteration-capped';
      }
    } catch (error) {
      logger.warn('agent.live_failed', { code: error.code ?? 'LLM_ERROR', message: error.message, requestId: ctx.requestId });
      if (!emitted) {
        // Surface enough for someone without log access to fix it: the HTTP status and the
        // provider's own message. "LLM_HTTP_ERROR" alone cannot be acted on; "HTTP 404 model not
        // found" can.
        return { completed: false, reason: error.code ?? 'LLM_ERROR', detail: describeLlmFailure(error) };
      }
      // Tool progress is already on screen; restarting the turn would duplicate it. Finish honest.
      text = 'I hit a problem talking to my model partway through, so I stopped rather than guess at an answer. What I already found is above — ask me again in a moment.';
      profile = 'live-degraded';
      ctx.fallbackReason = error.code ?? 'LLM_ERROR';
      const detail = describeLlmFailure(error);
      if (detail) ctx.fallbackDetail = detail;
    }

    // ── Grounding check ───────────────────────────────────────────────────
    // The model must not state a price that no tool returned. This is enforced, not requested:
    // an ungrounded figure is traced and the prose is replaced with a tool-derived summary.
    const ungrounded = findUngroundedPrices(text, toolPayloads, message);
    if (ungrounded.length) {
      this.deps.analytics.emit('guardrail_triggered', {
        sessionId: session._id, userId: user?._id, props: { kind: 'ungrounded_price' }
      });
      logger.warn('agent.ungrounded_price', { requestId: ctx.requestId, amounts: ungrounded.slice(0, 5) });
      text = groundedSummary(ctx, this.deps.catalogue);
      profile = 'live-grounding-corrected';
    }

    const safeText = this.sanitiseOutput(text) || groundedSummary(ctx, this.deps.catalogue);
    ctx.profile = profile;
    for (const chunk of chunkText(safeText)) {
      yield emit('message.delta', { messageId, text: chunk });
    }
    if (cartUpdated) yield emit('cart.updated', { cart: publicCart(cartUpdated) });

    yield emit('message.end', this.endPayload({ messageId, text: safeText, ctx, quickReplies: liveQuickReplies(ctx), started }));
    this.persistAssistant({ session, user, messageId, text: safeText, toolCalls, components: componentList, ctx, stopped: false });

    this.deps.analytics.emit('agent_turn_completed', {
      sessionId: session._id,
      userId: user?._id,
      props: {
        toolCalls: toolCalls.length,
        iterations,
        durationMs: Date.now() - started,
        stopped: false,
        profile,
        model: this.deps.llm.model,
        provider: env.llmProvider,
        tokensIn: usage?.prompt_tokens ?? null,
        tokensOut: usage?.completion_tokens ?? null
      }
    });

    if (ctx.candidateIds?.length) {
      const merchantIds = [...new Set(ctx.candidateIds
        .map((id) => this.deps.catalogue.getRaw(id)?.merchantId)
        .filter(Boolean))];
      this.deps.analytics.emit('recommendation_shown', {
        sessionId: session._id,
        userId: user?._id,
        merchantId: merchantIds[0],
        props: { productCount: ctx.candidateIds.length, revision: ctx.requirement?.revision ?? 0, merchantIds }
      });
    }

    return { completed: true };
  }

  // ── Planning ─────────────────────────────────────────────────────────────
  async plan({ intent, message, ctx }) {
    const q = (ctx.requirement?.quantity ?? 1);
    switch (intent) {
      case 'checkout': return this.planCheckout(message, ctx);
      case 'compare': return this.planCompare(message, ctx);
      case 'cart_add': return this.planAddToCart(message, ctx, q);
      case 'cart_remove': return this.planRemove(message, ctx);
      case 'cart_clear': return this.planClear(ctx);
      case 'cart_quantity': return this.planQuantity(message, ctx);
      case 'cart_view': return this.planCartView(ctx);
      case 'availability': return this.planAvailability(message, ctx);
      case 'policy': return this.planPolicy(message, ctx);
      case 'followup':
        // Nothing on screen yet → a spec word is really a discovery request, not a follow-up.
        if (!ctx.candidateIds?.length && (ctx.requirement?.categorySlug || ctx.requirement?.budgetMinor)) return this.planDiscover(message, ctx);
        return this.planFollowup(message, ctx);
      case 'greeting': return this.planGreeting(ctx);
      default: return this.planDiscover(message, ctx);
    }
  }

  planGreeting(ctx) {
    const chips = requirementChips(ctx.requirement);
    const text = chips.length
      ? `Hello. You were looking at ${describeRequirement(ctx.requirement)} — want me to keep going from there, or start fresh?`
      : 'Hello. Tell me what you need and your budget, for example "a laptop for full-stack development under $900 with 16 GB RAM", and I will compare real options from the catalogue.';
    return {
      steps: [],
      text,
      compose: () => text,
      quickReplies: () => ['Continue my search', 'Start over', 'Show me laptops']
    };
  }

  /** Discovery: the core flow. Clarify at most once, then always show grounded results. */
  planDiscover(message, ctx) {
    const requirement = ctx.requirement ?? {};
    const pool = this.deps.catalogue.products.find({ status: 'active', stock: { $gt: 0 }, ...(requirement.categorySlug ? { categoryId: this.deps.catalogue.category(requirement.categorySlug)?._id } : {}) });

    // One clarification, only when it would change the shortlist.
    const clarificationsAsked = ctx.session.chat?.clarificationsAsked ?? {};
    const clarifyCount = Object.keys(clarificationsAsked).length;
    const budgetMissing = !requirement.budgetMinor && !requirement.budgetIsUnspecified;

    if (!requirement.categorySlug && !ctx.candidateIds?.length) {
      if (!clarificationsAsked.category && clarifyCount < env.clarifyMaxQuestions && /\b(something|anything|gift|cheap)\b/i.test(message)) {
        return { clarify: { kind: 'category', ...CLARIFY_QUESTIONS.category, poolSize: pool.length }, text: CLARIFY_QUESTIONS.category.question };
      }
      // Infer nothing: ask once, otherwise search everything.
    }
    if (requirement.categorySlug && budgetMissing && !clarificationsAsked.budget && clarifyCount < env.clarifyMaxQuestions && pool.length > 15) {
      return { clarify: { kind: 'budget', ...CLARIFY_QUESTIONS.budget, poolSize: pool.length }, text: CLARIFY_QUESTIONS.budget.question };
    }

    const filters = (requirement.hardConstraints ?? []).filter((c) => c.kind === 'attribute');
    const constraintSummary = describeRequirement(requirement);
    const quantity = requirement.quantity ?? 1;

    return {
      steps: [{ tool: 'search_products', args: { query: requirement.categorySlug ? undefined : message, categorySlug: requirement.categorySlug ?? undefined, budgetMaxMinor: requirement.budgetMinor ?? undefined, filters, limit: 5 } }],
      quickReplies: (c) => {
        const ids = c.candidateIds ?? [];
        const replies = ['Compare the top 2'];
        if (ids.length) replies.push('Add the cheapest to my cart');
        if (c.requirement?.budgetMinor) replies.push(`Only ≤ ${formatMoney(Math.round(c.requirement.budgetMinor * 0.8))}`);
        replies.push('Checkout');
        return replies.slice(0, 4);
      },
      compose: (c) => {
        const result = c.lastOutcome?.result;
        if (!result?.products?.length) {
          return `I could not find anything in the catalogue that matches ${constraintSummary}. Tell me which part is flexible — budget, category or a spec — and I will try again.`;
        }
        const [best] = result.products;
        const lines = [];
        const budgetText = c.requirement?.budgetMinor ? ` under ${formatMoney(c.requirement.budgetMinor)}` : '';
        lines.push(`I found ${result.count} ${result.count === 1 ? 'option' : 'options'} matching ${constraintSummary.replace(/^laptops/, 'laptops')}${budgetText ? '' : ''}.`);
        if (c.requirementChanged) lines.push(`Requirement updated (revision ${c.requirement.revision}).`);
        lines.push(
          `Best fit: ${best.title} from ${best.merchant?.name} at ${best.price.display} — ${best.whyItFits}.` +
            (best.stock <= 3 ? ` Only ${best.stock} left.` : ' In stock.')
        );
        if (result.relaxed?.length) lines.push(`Heads up: I relaxed ${result.relaxed.join('; ')} to find these.`);
        const over = result.products.filter((p) => p.slightlyOverBudget);
        if (over.length) lines.push(`${over[0].title} is ${formatMoney(over[0].price.amountMinor - (c.requirement.budgetMinor ?? 0))} over your budget — want to see it anyway?`);
        if (quantity > 1) lines.push(`You asked for ${quantity} of these — I can add them to the cart in one step.`);
        lines.push('Tell me if you want a comparison, a different budget, or more options.');
        return lines.join(' ');
      }
    };
  }

  planCompare(message, ctx) {
    const ids = ctx.session.chat?.lastCandidateProductIds ?? [];
    const wanted = /\b(three|3)\b/.test(message) ? 3 : /\b(four|4)\b/.test(message) ? 4 : 2;
    const picks = ids.slice(0, Math.max(2, Math.min(4, wanted)));
    if (picks.length < 2) {
      const text = 'I need at least two products on the table before I can compare them. Tell me what you are shopping for and I will put two or three side by side.';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Show me laptops under $900', 'Show me phones under $600'] };
    }
    return {
      steps: [{ tool: 'compare_products', args: { productIds: picks } }],
      quickReplies: () => ['Add the cheapest to my cart', 'Which has the better battery?', 'Show more options'],
      compose: (c) => {
        const result = c.lastOutcome?.result;
        const names = result.products.map((p) => `${p.title} (${p.price.display})`).join(' vs ');
        const winner = result.products.find((p) => p.id === result.winnerProductId);
        const rows = result.rows.filter((r) => r.key !== 'stock');
        const highlights = rows
          .slice(0, 3)
          .map((row) => {
            const best = row.values.filter((v) => v.better).map((v) => result.products.find((p) => p.id === v.productId)?.title).filter(Boolean);
            return best.length ? `${row.label}: ${best.join(', ')}` : null;
          })
          .filter(Boolean);
        return [
          `Here is ${names} side by side.`,
          winner ? `${winner.title} wins the most rows (${winner.price.display}).` : '',
          highlights.length ? `Where each one leads — ${highlights.join(' · ')}.` : '',
          result.caveats.length ? result.caveats.join(' ') : '',
          'Want me to add one of these to your cart?'
        ].filter(Boolean).join(' ');
      }
    };
  }

  planAddToCart(message, ctx, quantity) {
    const ids = ctx.session.chat?.lastCandidateProductIds ?? [];
    const product = resolveProductReference(message, ids, this.deps);
    const asked = parseQuantityFrom(message);
    const hasProduct = product || /\b(cart|basket)\b/i.test(message);
    if (!hasProduct) {
      const text = 'Which product should I add? Tell me the name or say "add the cheapest to my cart".';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Add the cheapest to my cart', 'Show me the options again'] };
    }
    const qty = Math.min(10, Math.max(1, asked ?? quantity ?? 1));
    return {
      steps: [{ tool: 'add_to_cart', args: { productId: product._id, quantity: qty } }],
      quickReplies: () => ['View cart', 'Checkout', 'Add one more', 'Show alternatives'],
      failureText: (error) => `${error.message} ${error.details?.available !== undefined ? `There are ${error.details.available} available.` : ''}`.trim(),
      compose: (c) => {
        const result = c.lastOutcome?.result;
        const cart = result?.cart;
        if (!cart) return 'I could not add that to your cart just now.';
        return `Added ${result.line.quantity} × ${result.line.title ?? 'the item'} at ${formatMoney(result.line.unitPriceMinor)} each. Your cart now has ${cart.itemCount} item${cart.itemCount === 1 ? '' : 's'} with a subtotal of ${cart.display}. Nothing is charged yet — checkout is a separate, explicit step.`;
      }
    };
  }

  planRemove(message, ctx) {
    const ids = ctx.session.chat?.lastCandidateProductIds ?? [];
    const cartDoc = this.deps.cart.getOrCreate({ sessionId: ctx.session._id, userId: ctx.user?._id });
    const cart = this.deps.cart.toDto(cartDoc);
    const cartProductIds = cart.items.map((i) => i.productId);
    const mentioned = resolveProductReference(message, cartProductIds, this.deps);
    const affirmative = /^(yes|yeah|yep|do it|please do|go ahead|confirm)\b/i.test(message.trim());
    if (!cart.itemCount) {
      const text = 'Your cart is already empty.';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Show me laptops', 'Show me phones'] };
    }
    const target = mentioned ?? (affirmative ? this.deps.catalogue.getRaw(ctx.session.chat?.pendingRemovalId) : null);
    if (!target) {
      const names = cart.items.map((i) => i.title).join(', ');
      const text = `You have ${names} in your cart. Which one should I remove?`;
      return { steps: [], text, compose: () => text, quickReplies: () => cart.items.slice(0, 4).map((i) => `Remove ${i.title}`) };
    }
    ctx.confirmed = true;
    return {
      steps: [{ tool: 'remove_cart_item', args: { productId: target._id }, confirmed: true }],
      quickReplies: () => ['View cart', 'Checkout', 'Show alternatives'],
      compose: (c) => {
        const cart2 = c.lastOutcome?.result?.cart;
        return `Removed ${target.title} from your cart.${cart2 ? ` Your cart is now ${cart2.itemCount} item${cart2.itemCount === 1 ? '' : 's'} at ${cart2.display}.` : ''}`;
      }
    };
  }

  planClear(ctx) {
    const cartDoc = this.deps.cart.getOrCreate({ sessionId: ctx.session._id, userId: ctx.user?._id });
    const cart = this.deps.cart.toDto(cartDoc);
    if (!cart.itemCount) {
      const text = 'Your cart is already empty, so there is nothing to remove.';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Show me laptops'] };
    }
    return {
      steps: [{ tool: 'clear_cart', args: { confirm: true }, confirmed: true }],
      quickReplies: () => ['Show me laptops', 'Start over'],
      compose: () => 'Your cart is empty now. Nothing was charged.'
    };
  }

  planQuantity(message, ctx) {
    const cartDoc = this.deps.cart.getOrCreate({ sessionId: ctx.session._id, userId: ctx.user?._id });
    const cart = this.deps.cart.toDto(cartDoc);
    if (!cart.itemCount) {
      const text = 'Your cart is empty — tell me what to add first.';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Show me laptops'] };
    }
    const ids = cart.items.map((i) => i.productId);
    const target = resolveProductReference(message, ids, this.deps) ?? this.deps.catalogue.getRaw(ids[0]);
    const quantity = parseQuantityFrom(message) ?? 1;
    return {
      steps: [{ tool: 'update_cart_item', args: { productId: target._id, quantity } }],
      quickReplies: () => ['View cart', 'Checkout', 'Remove it'],
      failureText: (error) => error.message,
      compose: (c) => {
        const result = c.lastOutcome?.result?.cart;
        return `Set ${target.title} to ${quantity}${result ? `. Cart subtotal is now ${result.display}` : ''}.`;
      }
    };
  }

  planCartView(ctx) {
    return {
      steps: [{ tool: 'view_cart', args: {} }],
      quickReplies: () => ['Checkout', 'Remove the last item', 'Add one more'],
      compose: (c) => {
        const cart = c.lastOutcome?.result?.cart;
        if (!cart?.itemCount) return 'Your cart is empty. Tell me what you need and I will find options with real prices.';
        const lines = cart.items.map((i) => `${i.quantity} × ${i.title} at ${i.unitPriceDisplay ?? formatMoney(i.unitPriceMinor)}`).join(', ');
        const warnings = cart.warnings?.length ? ` Note: ${cart.warnings[0].message}` : '';
        return `Your cart: ${lines}. Subtotal ${cart.display}.${warnings} Ready to check out whenever you are.`;
      }
    };
  }

  planAvailability(message, ctx) {
    const ids = ctx.session.chat?.lastCandidateProductIds ?? [];
    const asked = resolveProductReference(message, ids, this.deps);
    const targets = asked ? [asked._id] : ids.slice(0, 4);
    // Mentions of products we do not stock must be handled honestly (golden prompt G-08).
    const mentionedBrand = /\b(macbook|iphone 1[0-9]|galaxy s|surface pro|pixel \d)\b/i.exec(message);
    if (mentionedBrand && !ids.some((id) => (this.deps.catalogue.getRaw(id)?.title ?? '').toLowerCase().includes(mentionedBrand[1].toLowerCase()))) {
      const fallback = this.deps.catalogue.searchForAgent({ query: message, limit: 3 });
      return {
        steps: [{ tool: 'search_products', args: { query: message, limit: 3 } }],
        quickReplies: () => ['Compare the top 2', 'Search again with my budget'],
        compose: () =>
          `${mentionedBrand[1]} is not in this catalogue, so I cannot quote a price or stock for it — I will not guess. ` +
          (fallback.products.length ? `The closest things we do stock are shown above (from ${fallback.products[0].price.display}).` : 'Tell me the category and budget and I will show what we do stock.')
      };
    }
    if (!targets.length) {
      const text = 'Tell me which product to check and I will look at live stock and price.';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Show me laptops under $900'] };
    }
    return {
      steps: [{ tool: 'check_availability', args: { productIds: targets } }],
      quickReplies: () => ['Add it to my cart', 'Compare the top 2', 'Show alternatives'],
      compose: (c) => {
        const items = c.lastOutcome?.result?.items ?? [];
        const parts = items.map((i) => {
          const name = i.title ?? i.productId;
          if (i.archived) return `${name} is no longer sold.`;
          if (i.stock <= 0) return `${name} is out of stock right now — I can suggest alternatives.`;
          const changed = i.priceChanged ? ` The price changed to ${formatMoney(i.currentPriceMinor)}.` : '';
          return `${name}: ${i.stock} in stock at ${formatMoney(i.currentPriceMinor)}.${changed}`;
        });
        return parts.join(' ') || 'I could not read availability just now.';
      }
    };
  }

  planPolicy(message, ctx) {
    const topic = /\bship|deliver/i.test(message)
      ? 'shipping'
      : /\breturn|refund/i.test(message)
        ? 'returns'
        : /\bwarrant/i.test(message)
          ? 'warranty'
          : /\btax/i.test(message)
            ? 'tax'
            : /\bpay|secure|card/i.test(message)
              ? 'payment'
              : 'privacy';
    return {
      steps: [{ tool: 'answer_policy', args: { topic } }],
      quickReplies: () => ['Show me laptops under $900', 'What about returns?', 'Checkout'],
      compose: (c) => {
        const policy = c.lastOutcome?.result;
        return policy?.text ?? 'I do not have that policy stored.';
      }
    };
  }

  planFollowup(message, ctx) {
    const ids = ctx.session.chat?.lastCandidateProductIds ?? [];
    const product = resolveProductReference(message, ids, this.deps);
    if (!product) {
      const text = 'I have not shown you any product yet — tell me what you are shopping for and I will pull up real options.';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Show me laptops under $900'] };
    }
    const steps = [{ tool: 'get_product', args: { productId: product._id } }, { tool: 'check_availability', args: { productIds: [product._id] } }];
    return {
      steps,
      quickReplies: () => ['Add it to my cart', 'Compare the top 2', 'Show alternatives'],
      compose: (c) => {
        const full = c.toolResults?.[0] ?? this.deps.catalogue.getProduct({ productId: product._id });
        const availability = c.toolResults?.[1]?.items?.[0];
        const lower = message.toLowerCase();
        const answerFor = (key, label, formatter = (v) => String(v)) => {
          const value = full.attributes?.[key];
          if (value === undefined || value === null) return `The catalogue does not specify ${label} for this product, so I will not guess — I can ask the merchant.`;
          return `${full.title}: ${label} is ${formatter(value)}.`;
        };
        const spec = full.specs?.find((s) => lower.includes(s.key.toLowerCase()) || lower.includes(s.label.toLowerCase().split(' ')[0]));
        let answer;
        if (/\bbattery\b/.test(lower) && full.attributes?.batteryWh) answer = answerFor('batteryWh', 'battery capacity', (v) => `${v} Wh`);
        else if (/\bbattery\b/.test(lower) && full.attributes?.batteryH) answer = answerFor('batteryH', 'battery life', (v) => `${v} hours`);
        else if (/\bweight|heavy|light\b/.test(lower) && full.attributes?.weightG) answer = answerFor('weightG', 'weight', (v) => `${(v / 1000).toFixed(2)} kg`);
        else if (/\bram|memory\b/.test(lower)) answer = answerFor('ramGb', 'RAM', (v) => `${v} GB`);
        else if (/\bstorage|ssd\b/.test(lower)) answer = answerFor('storageGb', 'storage', (v) => `${v} GB`);
        else if (/\bscreen|display\b/.test(lower)) answer = answerFor('screenIn', 'screen size', (v) => `${v} inches`);
        else if (/\bupgrade/.test(lower)) answer = answerFor('upgradeableRam', 'upgradeable RAM', (v) => (v ? 'yes' : 'no'));
        else if (/\bkeyboard|backlit\b/.test(lower)) answer = answerFor('backlitKeyboard', 'a backlit keyboard', (v) => (v ? 'yes' : 'no'));
        else if (/\bcamera\b/.test(lower)) answer = answerFor('cameraMp', 'main camera', (v) => `${v} MP`);
        else if (/\bnoise\b/.test(lower)) answer = answerFor('noiseCancelling', 'noise cancelling', (v) => (v ? 'yes' : 'no'));
        else if (/\bcpu|processor\b/.test(lower)) answer = answerFor('cpu', 'processor');
        else if (/\bgpu|graphics\b/.test(lower)) answer = answerFor('gpu', 'graphics');
        else if (/\bwarranty\b/.test(lower)) answer = `Warranty is ${full.warrantyMonths} months, and returns are accepted for ${full.returnDays} days.`;
        else if (/\bprice|cost|how much\b/.test(lower)) answer = `It is ${full.price.display} at ${full.merchant?.name}.`;
        else if (/\bstock|available\b/.test(lower)) answer = `There are ${availability?.stock ?? full.stock} available right now.`;
        else if (spec) answer = `${full.title}: ${spec.label} is ${spec.value}.`;
        else answer = `${full.title} is ${full.price.display} at ${full.merchant?.name}, ${full.stock} in stock. Ask me about battery, weight, RAM, storage, upgradeability, warranty or returns and I will pull the exact value.`;
        const change = availability?.priceChanged ? ` Note: the price changed to ${formatMoney(availability.currentPriceMinor)} since I first showed it.` : '';
        return answer + change;
      }
    };
  }

  planCheckout(message, ctx) {
    if (PAY_FOR_ME.test(message) && AUTONOMOUS.test(message)) {
      const text =
        'I cannot pay on your behalf — by design, the agent has no access to payment. Your cart is ready: press "Approve & Pay" on the checkout page, then authorise the payment in PayPal. I will keep the order review open for 15 minutes.';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Show my cart', 'Compare the top 2'] };
    }
    const cartDoc = this.deps.cart.getOrCreate({ sessionId: ctx.session._id, userId: ctx.user?._id });
    const cart = this.deps.cart.toDto(cartDoc);
    if (!cart.itemCount) {
      const text = 'Your cart is empty, so there is nothing to check out yet. Tell me what you need and I will find options.';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Show me laptops under $900', 'Show me phones under $600'] };
    }
    if (!ctx.user?.email) {
      const text = 'I can prepare the order, but I need an email address for the receipt. You can also enter it on the checkout page. Press "Prepare my order" and I will set it up — nothing is charged until you approve it in PayPal.';
      return { steps: [], text, compose: () => text, quickReplies: () => ['Prepare my order', 'Keep shopping'] };
    }
    return {
      steps: [{ tool: 'prepare_checkout', args: { confirm: true } }],
      quickReplies: () => ['Open checkout', 'Change quantity', 'Keep shopping'],
      failureText: (error) => `${error.message}`,
      compose: (c) => {
        const result = c.lastOutcome?.result;
        if (!result?.orderId) return 'I could not prepare the order just now.';
        const a = result.amounts;
        const lineCount = c.lastOutcome?.components?.[0]?.payload?.lines?.length ?? 0;
        return [
          `Order ${result.orderNumber} is ready for review: ${lineCount} item(s).`,
          `Subtotal ${a.display.subtotal}, shipping ${a.display.shipping}, tax ${a.display.tax} (${(a.taxRateBps / 100).toFixed(2)}%), total ${a.display.total}.`,
          'Press "Approve & Pay" on the checkout page to review and authorise the payment in PayPal — I cannot pay for you. Nothing is charged before you approve, and the items are reserved for 15 minutes.'
        ].join(' ');
      }
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  screenMessage(message) {
    if (CARD_LIKE.test(message) || PII_KEYS.test(message)) {
      return {
        hit: true,
        kind: 'pii_detected',
        reply: 'Please do not share card numbers, security codes or government ids in chat — PayPal handles payment details securely and I never see them. Tell me the product you want and I will get it to checkout.'
      };
    }
    if (PAY_FOR_ME.test(message) && AUTONOMOUS.test(message)) {
      return {
        hit: true,
        kind: 'payment_autonomy',
        reply:
          'I cannot pay on your behalf — I have no access to payment and only you can approve it. What I can do is prepare the order, then PayPal checkout opens for you to review and approve. Once you approve, the backend verifies the capture and only then is the order marked paid.'
      };
    }
    if (OFF_TOPIC.test(message)) {
      return { hit: true, kind: 'off_topic', reply: 'That is outside what I do — I only help with shopping in this store. Tell me what you are looking for (and a budget) and I will compare real options.' };
    }
    if (/\b(ignore (all )?(previous|prior) instructions|system prompt|you are now|act as)\b/i.test(message)) {
      return { hit: true, kind: 'injection_suspected', reply: 'I will stick to shopping. Tell me what you need and I will search the catalogue.' };
    }
    return { hit: false };
  }

  applyClarificationAnswer(pending, message, ctx) {
    const lower = message.toLowerCase();
    if (pending.kind === 'budget') {
      const map = CLARIFY_QUESTIONS.budget.optionMap;
      const exact = Object.keys(map).find((k) => lower.includes(k.toLowerCase()));
      if (exact) {
        const value = map[exact];
        if (value === 'any') ctx.requirement.budgetIsUnspecified = true;
        else ctx.requirement.budgetMinor = value;
      } else {
        const parsed = /(\d[\d,]*)/.exec(lower);
        if (parsed) ctx.requirement.budgetMinor = Number(parsed[1].replace(/,/g, '')) * 100;
        else if (/\b(any|no limit|whatever|skip|don't care|dont care)\b/.test(lower)) ctx.requirement.budgetIsUnspecified = true;
        else if (/\b(cheap|budget)\b/.test(lower)) ctx.requirement.budgetMinor = 50000;
      }
    }
    if (pending.kind === 'category') {
      const found = Object.entries({ laptops: ['laptop'], phones: ['phone'], headphones: ['headphone'], monitors: ['monitor'] }).find(([, words]) => words.some((w) => lower.includes(w)));
      if (found) ctx.requirement.categorySlug = found[0];
    }
    ctx.requirementChanged = true;
  }

  updateSessionChat(session, patch = {}) {
    const chat = { ...(session.chat ?? {}) };
    const clarificationsAsked = { ...(chat.clarificationsAsked ?? {}) };
    if (patch.pendingClarification) clarificationsAsked[patch.pendingClarification.kind] = new Date().toISOString();
    const hasPendingKey = Object.prototype.hasOwnProperty.call(patch, 'pendingClarification');
    const { pendingClarification, ...rest } = patch;
    const next = {
      ...chat,
      ...rest,
      pendingClarification: hasPendingKey ? pendingClarification : chat.pendingClarification ?? null,
      clarificationsAsked,
      requirementRevision: rest.requirement?.revision ?? this.currentRevision ?? chat.requirementRevision ?? 0,
      messageCount: (chat.messageCount ?? 0) + 1,
      lastMessageAt: new Date().toISOString()
    };
    this.deps.store.collection('sessions').updateOne({ _id: session._id }, { chat: next });
    return next;
  }

  persistAssistant({ session, user, messageId, text, toolCalls, components: componentList, ctx, stopped }) {
    const candidates = ctx.candidateIds ?? session.chat?.lastCandidateProductIds ?? [];
    const prices = { ...(session.chat?.lastPrices ?? {}) };
    for (const id of candidates) {
      const product = this.deps.catalogue.getRaw(id);
      if (product) prices[id] = product.priceMinor;
    }
    this.deps.store.collection('chat_messages').insert({
      sessionId: session._id,
      userId: user?._id,
      role: 'assistant',
      messageId,
      content: text,
      ui: componentList,
      requirementRevision: ctx.requirement?.revision ?? 0,
      toolCalls,
      stopped: Boolean(stopped)
    });
    this.currentRevision = ctx.requirement?.revision ?? 0;
    this.updateSessionChat(session, {
      requirement: ctx.requirement,
      lastCandidateProductIds: candidates,
      lastPrices: prices,
      pendingClarification: null
    });
  }

  endPayload({ messageId, text, ctx, quickReplies, started }) {
    return {
      messageId,
      text,
      requirement: ctx.requirement ?? null,
      requirementRevision: ctx.requirement?.revision ?? 0,
      requirementChips: requirementChips(ctx.requirement),
      candidateProductIds: ctx.candidateIds ?? [],
      quickReplies,
      assumptions: ctx.requirement?.assumptions ?? [],
      usage: {
        tokensIn: Math.ceil(text.length / 4) + 900,
        tokensOut: Math.ceil(text.length / 4),
        // The profile reports what ACTUALLY ran, never what the flag asked for: a turn served by
        // the deterministic planner is never labelled live, even when FEATURE_LIVE_LLM is on.
        profile: ctx.profile ?? 'deterministic',
        model: ctx.profile?.startsWith('live') ? this.deps.llm?.model ?? null : null,
        // Why a degraded turn degraded, so the failure is diagnosable from the response alone.
        ...(ctx.fallbackReason ? { fallbackReason: ctx.fallbackReason } : {}),
        ...(ctx.fallbackDetail ? { fallbackDetail: ctx.fallbackDetail } : {}),
        durationMs: Date.now() - started
      },
      stopped: false
    };
  }

  defaultFailureText(error) {
    if (error.code === 'INSUFFICIENT_STOCK') return `${error.message}`;
    if (error.code === 'CART_EMPTY') return 'Your cart is empty, so there is nothing to do yet. Tell me what you need.';
    if (error.code === 'QUOTE_STALE') return 'Prices changed while we were talking, so I stopped rather than charge a different amount. Review the new total and approve again.';
    if (error.code === 'ITEM_UNAVAILABLE') return 'One of those items is no longer available, so I did not proceed. Here is the updated cart.';
    if (error.code === 'HOLD_EXPIRED') return 'The 15-minute hold on this order expired, so I released the stock. Refresh your cart to start a fresh checkout.';
    return `I could not complete that: ${error.message}`;
  }

  /** Post-processor: no raw JSON, no markdown tables, no foreign links (ai_agent_spec.md §9). */
  sanitiseOutput(text) {
    return String(text)
      .replace(/```[\s\S]*?```/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\|.*\|/g, '')
      .replace(/\s{3,}/g, ' ')
      .trim();
  }
}

/**
 * Prices the model stated that no tool in this turn returned. Compared against the compacted tool
 * payloads in both display and minor-unit form, so "$649.00" matches whether the tool reported
 * "649.00" or 64900. This is the enforcement behind "never state a price that did not come from a
 * tool" — the system prompt asks for it, this checks it.
 */
/**
 * Does this message ask for a product? Used only to decide whether to insist on one catalogue
 * lookup before answering. Deliberately textual and cheap: false positives cost one extra tool
 * call, which is recoverable; false negatives let the agent answer from memory, which is not.
 */
function looksLikeProductRequest(message) {
  const text = String(message ?? '').toLowerCase();
  if (text.trim().length < 3) return false;
  if (/\b(hi|hello|hey|thanks|thank you|ok|okay|bye)\b/.test(text) && text.length < 24) return false;
  return /\b(laptop|phone|headphone|earbud|monitor|screen|display|buy|need|want|looking for|show me|find|recommend|cheapest|best|under|below|budget|compare|cart|checkout|price|in stock|available)\b/.test(text);
}

/**
 * Prices in the model's prose that no tool returned.
 *
 * The rule exists so the agent cannot invent a price. It must not fire on numbers the shopper
 * supplied themselves — "your $1,300 budget" is a quote, not a fabrication — which is what it used
 * to do, replacing an otherwise correct answer with a generic prompt.
 */
function findUngroundedPrices(text, payloads, userMessage = '') {
  const haystack = JSON.stringify(payloads ?? []);
  const said = String(userMessage ?? '');
  const amounts = [...String(text ?? '').matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].map((m) => m[1].replace(/,/g, ''));
  return [...new Set(amounts)].filter((amount) => {
    const numeric = Number(amount);
    if (!Number.isFinite(numeric)) return false;
    // Quoted back from the shopper's own message.
    if (said.includes(amount) || said.includes(amount.replace(/\B(?=(\d{3})+(?!\d))/g, ','))) return false;
    const minor = String(Math.round(numeric * 100));
    return !haystack.includes(amount) && !haystack.includes(minor);
  });
}

/** A summary built only from tool output — the safe landing when model prose fails grounding. */
function groundedSummary(ctx, catalogue) {
  const ids = ctx?.candidateIds ?? [];
  const first = ids.length && catalogue ? catalogue.getRaw(ids[0]) : null;
  if (first) {
    const rest = ids.length - 1;
    const more = rest > 0 ? ` There ${rest === 1 ? 'is 1 more option' : `are ${rest} more options`} if you want to compare.` : '';
    return `${first.title}${first.brand ? ` from ${first.brand}` : ''} is ${formatMoney(first.priceMinor)} and in stock.${more} Say "compare the top two" or press Approve & Pay when you are ready — the payment is always approved by you.`;
  }
  return 'I have your request. Tell me the category or your budget and I will search the live catalogue.';
}

/** Contextual follow-ups, mirroring the deterministic planner's chips. */
function liveQuickReplies(ctx) {
  const chips = [];
  if ((ctx?.candidateIds?.length ?? 0) >= 2) chips.push('Compare the top two', 'Add the cheapest to my cart');
  if (ctx?.cartUpdated) chips.push('What is in my cart', 'Checkout');
  if (!chips.length) chips.push('Show me laptops', 'Show me headphones');
  return chips.slice(0, 3);
}

function summariseResult(outcome) {
  if (!outcome?.ok) return { error: outcome?.error?.code };
  const result = outcome.result ?? {};
  if (Array.isArray(result.products)) return { count: result.products.length };
  if (Array.isArray(result.items)) return { count: result.items.length };
  if (result.cart) return { itemCount: result.cart.itemCount };
  if (result.orderId) return { orderNumber: result.orderNumber };
  if (result.rows) return { rows: result.rows.length };
  return {};
}

function publicCart(cart) {
  return {
    itemCount: cart.itemCount,
    subtotalMinor: cart.subtotalMinor,
    currency: cart.currency,
    display: cart.display,
    items: cart.items.map((i) => ({
      productId: i.productId,
      title: i.title,
      quantity: i.quantity,
      unitPriceMinor: i.unitPriceMinor,
      lineTotalMinor: i.lineTotalMinor,
      availableStock: i.availableStock,
      unavailable: Boolean(i.unavailable)
    })),
    warnings: cart.warnings
  };
}

/** Small chunks so the UI can stream text realistically. */
function* chunkText(text, size = 48) {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

export default Orchestrator;
