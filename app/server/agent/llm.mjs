/**
 * Provider-agnostic chat-completions client.
 *
 * Speaks the OpenAI `/chat/completions` shape, which is implemented by OpenAI itself and by most
 * hosted and local alternatives (Groq, Together, DeepSeek, Fireworks, vLLM, Ollama's compat
 * endpoint, llama.cpp server…). Switching providers is therefore a base URL + key + model change,
 * with no code change — which is why the submission can name the model it used without the code
 * being tied to one vendor.
 *
 * Docs: ../docs/ai_agent_spec.md §4 · ../docs/env_setup.md §6
 */

export class LlmError extends Error {
  constructor(code, message, { status = 0, retryable = false, details } = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * @param {object} options
 * @param {string} options.baseUrl     e.g. https://api.openai.com/v1
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {number} [options.temperature]
 * @param {number} [options.perCallTimeoutMs]
 * @param {number} [options.maxRetries]
 * @param {Function} [options.fetchImpl] injectable for tests (defaults to global fetch)
 * @param {object} [options.logger]
 */
export function createLlmClient({
  baseUrl,
  apiKey,
  model,
  temperature = 0.2,
  perCallTimeoutMs = 8000,
  maxRetries = 1,
  fetchImpl = globalThis.fetch,
  logger = null
} = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  /**
   * One completion. Returns a normalised shape so callers never touch provider JSON details:
   *   { text, toolCalls: [{ id, name, arguments }], finishReason, usage, model }
   */
  async function chat({ messages, tools = [], toolChoice = 'auto', signal, timeoutMs = perCallTimeoutMs }) {
    if (!apiKey) throw new LlmError('LLM_NOT_CONFIGURED', 'No LLM API key is configured.', { retryable: false });

    const body = { model, messages, temperature };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      // Each attempt gets its own budget. A caller-provided signal (turn timeout) is honoured too,
      // so a slow turn cannot outlive LLM_TURN_TIMEOUT_MS.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); throw new LlmError('LLM_ABORTED', 'The turn was cancelled.', { retryable: false }); }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!response.ok) {
          const detail = await safeText(response);
          const retryable = RETRYABLE_STATUS.has(response.status);
          const error = new LlmError(
            response.status === 401 || response.status === 403 ? 'LLM_AUTH_FAILED' : 'LLM_HTTP_ERROR',
            `Model request failed (${response.status}).`,
            { status: response.status, retryable, details: { body: detail.slice(0, 500) } }
          );
          if (!retryable || attempt === maxRetries) throw error;
          lastError = error;
          await backoff(attempt, retryAfterMs(response, detail));
          continue;
        }

        const payload = await response.json();
        return normalise(payload);
      } catch (err) {
        const aborted = err?.name === 'AbortError';
        const error = aborted
          ? new LlmError('LLM_TIMEOUT', `The model did not answer within ${timeoutMs}ms.`, { retryable: true })
          : err instanceof LlmError
            ? err
            : new LlmError('LLM_NETWORK_ERROR', `Could not reach the model endpoint: ${err.message}`, { retryable: true });

        if (!error.retryable || attempt === maxRetries) throw error;
        lastError = error;
        logger?.warn?.('llm.retry', { attempt, code: error.code });
        await backoff(attempt);
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
    throw lastError ?? new LlmError('LLM_UNKNOWN', 'The model request failed.', { retryable: false });
  }

  return { chat, model, baseUrl, enabled: Boolean(apiKey) };
}

/** Provider JSON → our shape. Tolerates providers that omit ids or send a string message. */
function normalise(payload) {
  const choice = payload?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const rawCalls = message.tool_calls ?? [];

  const toolCalls = rawCalls
    .filter((call) => call?.function?.name)
    .map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function.name,
      arguments: call.function.arguments ?? '{}'
    }));

  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls,
    finishReason: choice.finish_reason ?? null,
    usage: payload?.usage ?? null,
    model: payload?.model ?? null
  };
}

async function safeText(response) {
  try { return await response.text(); } catch { return ''; }
}

/**
 * How long to wait before retrying.
 *
 * Fixed exponential backoff is wrong for rate limits: a 429 that says "try again in 1.02s" fails
 * identically if we come back after 250ms, and the retry is wasted. Providers put the wait in
 * `retry-after` (seconds, or an HTTP date) or inside the error text — honour whichever we find,
 * clamped so a misbehaving header cannot stall a turn past its budget.
 */
const parseRetryAfter = (value) => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
};

const retryAfterMs = (response, bodyText) => {
  const header = parseRetryAfter(response.headers?.get?.('retry-after'));
  if (header !== null) return header;
  // Groq and several others embed the wait in prose: "Please try again in 1.02s."
  const match = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(String(bodyText ?? ''));
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) return match[2].toLowerCase() === 'ms' ? value : value * 1000;
  }
  return null;
};

const backoff = (attempt, suggestedMs = null) => {
  const base = 250 * 2 ** attempt;
  const wait = suggestedMs === null ? base : Math.max(base, suggestedMs);
  return new Promise((resolve) => setTimeout(resolve, Math.min(wait, 5000)));
};
