import { escape } from './ui.js';

const activityNames = {
  reasoning: 'Thinking', commandExecution: 'Running a command', dynamicToolCall: 'Using a card tool',
  mcpToolCall: 'Using a connected tool', fileChange: 'Updating files', webSearch: 'Searching the web',
  imageView: 'Inspecting an image', plan: 'Planning', contextCompaction: 'Compacting context',
};
const imageKinds = new Set(['imageGeneration', 'registeredImage']);
export const runningStatuses = new Set(['dispatching', 'accepted', 'running', 'interrupt-requested']);

function workLabel(entry) {
  if (imageKinds.has(entry?.kind)) return 'Creating an image';
  return activityNames[entry?.kind] ?? 'Working';
}

function activityMarkup(entries, attemptId) {
  const rows = entries.map((entry) => {
    const data = entry.data ?? {};
    // Provider summaries and tool output already retained in the transcript.
    const detail = entry.text || (entry.kind === 'reasoning' ? (data.summary ?? []).join('\n') : '')
      || [data.command, data.tool ?? data.name, data.query, data.path, data.aggregatedOutput].filter(Boolean).join('\n');
    return `<div class="chat-work-entry"><strong>${escape(workLabel(entry))}</strong>${detail ? `<pre>${escape(detail)}</pre>` : ''}</div>`;
  }).join('');
  return `<details class="chat-work-details" data-detail-key="work:${escape(attemptId)}:${entries[0].sequence}"><summary>Activity · ${entries.length} ${entries.length === 1 ? 'step' : 'steps'}</summary>${rows}</details>`;
}

// Preserve chronology, grouping consecutive tool/status items between replies.
export function attemptMarkup(entries, attemptId, renderOutput, running = false) {
  let html = ''; let activity = [];
  const flush = () => { if (activity.length) html += activityMarkup(activity, attemptId); activity = []; };
  for (const entry of entries) {
    if (entry.kind === 'agentMessage' && !entry.text.trim()) continue;
    if (entry.kind === 'agentMessage' || entry.kind === 'notice' || imageKinds.has(entry.kind)) {
      flush();
      if (entry.kind === 'agentMessage') {
        html += `<div class="chat-item chat-reply" data-item-sequence="${entry.sequence}"><span class="chat-speaker">Codex</span><div class="chat-reply-text">${escape(entry.text)}</div>${!entry.completed ? `<small>${running ? 'Writing…' : 'Partial reply'}</small>` : ''}</div>`;
      } else if (imageKinds.has(entry.kind)) {
        html += `<div class="chat-item">${renderOutput(entry)}</div>`;
      } else html += `<div class="chat-item chat-notice">${escape(entry.text)}</div>`;
    } else activity.push(entry);
  }
  flush();
  return html;
}

export function progressState(snapshot) {
  const attempt = snapshot.attempts.find((entry) => runningStatuses.has(entry.status));
  if (attempt) {
    if (snapshot.requests.some((request) => request.attemptId === attempt.id && request.status === 'pending')) return { label: 'Waiting for your input', moving: false };
    if (attempt.status === 'interrupt-requested') return { label: 'Stopping…', moving: true, startedAt: attempt.startedAt };
    const entries = snapshot.items.filter((entry) => entry.attemptId === attempt.id);
    const last = entries.at(-1);
    const label = attempt.status === 'dispatching' ? 'Getting started…'
      : last?.kind === 'agentMessage' && !last.completed ? 'Writing a reply…'
        : last && !last.completed ? `${workLabel(last)}…` : 'Working…';
    return { label, moving: true, startedAt: attempt.startedAt };
  }
  if (snapshot.submissions.some((entry) => entry.status === 'waiting')) return { label: 'Waiting for the provider…', moving: true };
  if (snapshot.submissions.some((entry) => entry.status === 'queued')) return { label: 'Queued · starting soon', moving: true };
  return null;
}
