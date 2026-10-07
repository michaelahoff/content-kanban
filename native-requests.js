// Frameboard grants are exact conversation-scoped receipts. Native responses
// stay operation/turn scoped; never emit session caches or persistent rules.
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const canonical = (value) => JSON.stringify(value, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
export function operation(request) {
  const { method, params } = request;
  if (method === 'item/commandExecution/requestApproval' && typeof params.command === 'string' && typeof params.cwd === 'string') {
    return canonical({ method, command: params.command, cwd: params.cwd, environmentId: params.environmentId ?? null,
      kind: params.kind ?? 'command',
      networkApprovalContext: params.networkApprovalContext ?? null, additionalPermissions: params.additionalPermissions ?? null });
  }
  if (method === 'item/fileChange/requestApproval' && Array.isArray(params.changes) && params.changes.length) return canonical({ method, changes: params.changes, grantRoot: params.grantRoot ?? null });
  if (method === 'item/permissions/requestApproval' && object(params.permissions) && typeof params.cwd === 'string') return canonical({ method, cwd: params.cwd, environmentId: params.environmentId ?? null, permissions: params.permissions });
  return null;
}
export function nativeDecision(request, response) {
  if (!object(response)) fail('A native request needs an explicit response.');
  if (request.method === 'item/tool/requestUserInput') {
    if (Object.keys(response).length !== 1 || !object(response.answers)) fail('Answer the requested questions.');
    const questions = request.params.questions;
    if (!Array.isArray(questions) || !questions.length || Object.keys(response.answers).length !== questions.length) fail('Answer each question exactly once.');
    for (const q of questions) {
      const value = response.answers[q.id];
      if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.answers) || !value.answers.length
        || value.answers.some((answer) => typeof answer !== 'string' || answer.length > 200000)) fail('Invalid question answer.');
    }
    return { native: response, grant: null };
  }
  const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'];
  if (!methods.includes(request.method)) fail('This native request is unsupported. Stop remains available.');
  if (Object.keys(response).some((key) => !['decision', 'scope'].includes(key)) || !['accept', 'decline', 'cancel'].includes(response.decision)) fail('Use Allow or Deny. Native session caches and global rules are not supported.');
  const scope = response.scope ?? 'once';
  if (!['once', 'conversation', 'full'].includes(scope) || (scope !== 'once' && response.decision !== 'accept')) fail('Only an allowance can create a conversation grant.');
  const key = operation(request);
  if (scope === 'conversation' && !key) fail('This request does not expose a provable exact operation scope. Allow once or use full native access explicitly.');
  if (request.params.availableDecisions?.length && !request.params.availableDecisions.includes(response.decision)) fail('That decision is unavailable for this native request.');
  let native;
  if (request.method === 'item/permissions/requestApproval') native = { permissions: response.decision === 'accept' ? request.params.permissions : {}, scope: 'turn' };
  else native = { decision: response.decision };
  return { native, grant: scope === 'once' ? null : { kind: scope === 'full' ? 'full' : 'operation', operation: key } };
}
export function automaticDecision(request, grants) {
  const key = operation(request);
  if (request.method === 'item/tool/requestUserInput' || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(request.method)) return null;
  if (grants.some((g) => g.kind === 'full' || (key && g.kind === 'operation' && g.operation === key))) {
    try { return nativeDecision(request, { decision: 'accept' }).native; } catch { return null; }
  }
  return null;
}
