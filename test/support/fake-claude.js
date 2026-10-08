// Native stream-json fixture: no credentials, network, or inference.
import readline from 'node:readline';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
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
    if (message.request.subtype === 'initialize') response(message.request_id, { models: [{ value: 'sonnet', displayName: 'Fixture Sonnet' }, { value: 'opus', displayName: 'Fixture Opus' }], account: { secret: 'must-not-persist' } });
    if (message.request.subtype === 'set_model') response(message.request_id, {}, message.request.model === 'invalid' ? 'Model unavailable' : undefined);
    if (message.request.subtype === 'interrupt') {
      response(message.request_id, {});
      if (pending) { output({ type: 'result', is_error: true, session_id: id, errors: ['Interrupted'] }); pending = null; }
    }
  } else if (message.type === 'user') {
    pending = message;
    await record({ type: 'user', uuid: message.uuid, message: message.message });
    if (message.message.content.some((block) => block.text === 'wait')) continue;
    const text = `Fixture reply (${message.message.content.map((block) => block.type).join(',')})`;
    const assistant = { id: 'assistant-' + message.uuid, content: [{ type: 'text', text }], stop_reason: 'end_turn' };
    output({ type: 'stream_event', event: { type: 'message_start', message: { id: assistant.id } } });
    output({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    await record({ type: 'assistant', uuid: 'response-' + message.uuid, message: assistant });
    output({ type: 'assistant', message: assistant });
    output({ type: 'result', session_id: id, is_error: false, result: text }); pending = null;
  }
}
