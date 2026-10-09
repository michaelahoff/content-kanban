// Native stream-json fixture: no credentials, network, or inference.
import readline from 'node:readline';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.291'} (Claude Code)\n`); process.exit(0); }
const flagValue = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const id = flagValue('--session-id') || flagValue('--resume');
const output = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const response = (requestId, value, failure) => output({ type: 'control_response', response: { subtype: failure ? 'error' : 'success', request_id: requestId, ...(failure ? { error: failure } : { response: value }) } });
const project = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
const record = async (entry) => { await mkdir(project, { recursive: true }); await appendFile(path.join(project, `${id}.jsonl`), JSON.stringify(entry) + '\n'); };
let pending = null;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    if (message.request.subtype === 'initialize') response(message.request_id, { models: [{ value: 'sonnet', displayName: 'Fixture Sonnet', resolvedModel: 'claude-fixture-sonnet' }, { value: 'opus', displayName: 'Fixture Opus', resolvedModel: 'claude-fixture-opus' }],
      account: { secret: 'must-not-persist', email: 'fixture@example.com', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' } });
    if (message.request.subtype === 'set_model') response(message.request_id, {}, message.request.model === 'invalid' ? 'Model unavailable' : undefined);
    if (message.request.subtype === 'interrupt') {
      response(message.request_id, {});
      if (pending) { output({ type: 'result', is_error: true, session_id: id, errors: ['Interrupted'] }); pending = null; }
    }
  } else if (message.type === 'user') {
    pending = message;
    await record({ type: 'user', uuid: message.uuid, message: message.message });
    if (message.message.content.some((block) => block.text === 'wait')) continue;
    const prompt = message.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    // Like Claude Code 2.1.291 when the API rejects a document: a synthetic
    // error message, then the turn carries on without it.
    if (message.message.content.some((block) => block.type === 'document' && Buffer.from(block.source.data, 'base64').includes('unprocessable'))) {
      output({ type: 'assistant', uuid: 'api-error-' + message.uuid, error: 'invalid_request', is_api_error_message: true, message: { id: 'synthetic-' + message.uuid, model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: 'API Error: a document in the conversation could not be processed and was removed. Re-read the file with a different approach if you still need it.' }] } });
    }
    // A lane run prompt asks for a result block; answer with one.
    const text = prompt.includes('frameboard-result')
      ? 'Lane fixture reply\n\n```frameboard-result\n{"fields": {"intro": "Fixture intro"}, "notes": "Fixture notes"}\n```'
      : `Fixture reply (${message.message.content.map((block) => block.type).join(',')})`;
    const assistant = { id: 'assistant-' + message.uuid, content: [{ type: 'text', text }], stop_reason: 'end_turn' };
    output({ type: 'stream_event', event: { type: 'message_start', message: { id: assistant.id } } });
    // Like Claude Code with thinking: a thinking block streams first, and each
    // block then arrives as its own assistant message with block index 0.
    const thinking = prompt === 'think';
    if (thinking) output({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } });
    if (thinking) output({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } });
    output({ type: 'stream_event', event: { type: 'content_block_delta', index: thinking ? 1 : 0, delta: { type: 'text_delta', text } } });
    if (thinking) {
      const thought = { ...assistant, content: [{ type: 'thinking', thinking: 'Hmm' }], stop_reason: null };
      await record({ type: 'assistant', uuid: 'thought-' + message.uuid, message: thought });
      output({ type: 'assistant', uuid: 'thought-' + message.uuid, message: thought });
    }
    await record({ type: 'assistant', uuid: 'response-' + message.uuid, message: assistant });
    output({ type: 'assistant', uuid: 'response-' + message.uuid, message: assistant });
    output({ type: 'result', session_id: id, is_error: false, result: text }); pending = null;
  }
}
