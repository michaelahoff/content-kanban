// Writes a lane playbook through the API, replacing the lane's current one.
import { serializeDocument } from '../../public/playbook-format.js';
import { slug } from '../../playbooks.js';

export async function setPlaybook(ok, flowId, stage, settings, body = '') {
  const { lanes } = await ok('GET', `/api/flows/${flowId}/playbooks`);
  const existing = lanes.find((document) => document.laneId === stage.id);
  const text = serializeDocument({ lane: stage.id, ...settings }, body);
  return (await ok('PUT', `/api/flows/${flowId}/playbooks`, { path: existing?.path ?? `lanes/${slug(stage.name)}.md`, text, baseHash: existing?.hash ?? null })).document;
}
