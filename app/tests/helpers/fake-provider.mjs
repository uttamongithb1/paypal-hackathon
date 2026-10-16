/**
 * A scripted OpenAI-compatible provider for tests.
 *
 * The live model path must be verifiable in CI and on a machine with no API key, so the tests
 * speak the real wire protocol to a real HTTP server — same fetch path, same parser, same loop —
 * and only the model's *decisions* are scripted. That means the loop, the closed registry, the
 * argument validation, the SSE frames and the grounding check are all genuinely exercised.
 *
 * Usage:
 *   const provider = await startFakeProvider([turn1, turn2, ...]);
 *   // point LLM_BASE_URL at provider.baseUrl
 *   provider.calls        // every request body the server received
 *   await provider.close()
 *
 * Each scripted turn is either a tool call or a final answer:
 *   { tool: 'search_products', args: { query: 'laptop' } }
 *   { text: 'Here are three options.' }
 *   (body) => ({ tool: 'compare_products', args: { productIds: idsFrom(body) } })   // reactive step
 */
import http from 'node:http';

export async function startFakeProvider(script, { status = 200 } = {}) {
  const calls = [];
  let index = 0;

  const server = http.createServer(async (req, res) => {
    if (!req.url.endsWith('/chat/completions') || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    calls.push(body);

    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'scripted failure' } }));
      return;
    }

    let turn = script[Math.min(index, script.length - 1)];
    index += 1;
    // A scripted step may be a function of the request, so a test can react to what a previous
    // tool returned (e.g. compare the two products the search just produced) instead of hardcoding
    // ids it cannot know.
    if (typeof turn === 'function') turn = turn(body);

    // The model asked for a tool.
    if (turn?.tool) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fake', object: 'chat.completion', model: 'fake-model-1',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: turn.text ?? null,
            tool_calls: [{
              id: `call_${index}`,
              type: 'function',
              function: { name: turn.tool, arguments: JSON.stringify(turn.args ?? {}) }
            }]
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 420, completion_tokens: 24 }
      }));
      return;
    }

    // Or answered in prose.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-fake', object: 'chat.completion', model: 'fake-model-1',
      choices: [{ index: 0, message: { role: 'assistant', content: turn?.text ?? 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 480, completion_tokens: 40 }
    }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    /** Every request body the provider received — assertions read these. */
    calls,
    /** Tools the model asked for, in order. */
    requestedTools: () => calls
      .flatMap((call) => (call.messages ?? []).filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls))
      .map((call) => call.function?.name),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

export default startFakeProvider;
