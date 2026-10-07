// A credential-free loopback Responses peer for native Codex gates. It records
// what the installed harness actually sends to a model and can inject one
// deterministic tool call per request. It never sees account credentials.
import { createServer } from 'node:http';

const toolNames = (tools) => (tools ?? []).flatMap((tool) => tool.type === 'namespace'
  ? (tool.tools ?? []).map((inner) => `${tool.name}.${inner.name}`) : [tool.name ?? tool.type]);

export async function createResponsesFixture() {
  const requests = [];
  const queue = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(404); res.end(); return; }
    const serialized = JSON.stringify(body);
    const input = body.input ?? [];
    requests.push({
      body, serialized,
      authorization: Boolean(req.headers.authorization),
      tools: [...toolNames(body.tools), ...input.filter((item) => item.type === 'additional_tools').flatMap((item) => toolNames(item.tools))],
      toolOutputs: input.filter((item) => /_call_output$/.test(item.type)),
    });
    const n = requests.length;
    const step = queue.shift() ?? { text: 'FB_FIXTURE_RESPONSE' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    const id = `resp_fb_${n}`;
    emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    let item;
    if (step.functionCall) {
      item = { type: 'function_call', id: `fc_fb_${n}`, call_id: `call_fb_${n}`, name: step.functionCall.name, arguments: JSON.stringify(step.functionCall.arguments ?? {}) };
      emit('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } });
      emit('response.function_call_arguments.delta', { output_index: 0, item_id: item.id, delta: item.arguments });
    } else {
      item = { id: `msg_fb_${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] };
      emit('response.output_item.added', { output_index: 0, item: { ...item, content: [] } });
      emit('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: step.text });
    }
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    // Queue the next model responses: { text } or { functionCall: { name, arguments } }.
    respond(...steps) { queue.push(...steps); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
