// Lane playbooks, the project map and skills are Markdown files. This module
// reads them the same way in the browser and on the server: frontmatter
// settings, the prompt a lane run sends, and the result block a reply returns.
import { templates } from './card-template.js';
import { contextFields } from './chat-context.js';

export const maxDocumentLength = 200000;
export const runModes = ['on-enter', 'manual', 'off'];
export const conversationModes = ['continue', 'fresh'];
export const providers = ['codex', 'claude'];
// Playbooks say "display"; the card stores that image role as "cover".
const roleNames = { original: 'original', inspiration: 'inspiration', display: 'cover', cover: 'cover' };
const roleLabels = { original: 'Original', inspiration: 'Inspiration', cover: 'Display' };
const knownKeys = ['lane', 'run', 'provider', 'model', 'context', 'may_edit', 'set', 'conversation', 'skills'];
export const skillName = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
const notesInPrompt = 20000;

// Field keys may be written as camelCase, snake_case or their label.
const squash = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
export function setFields(templateId) {
  const template = templates[templateId];
  return [{ key: 'title', ...template.title }, ...template.fields];
}
function fieldKey(fields, name) {
  const wanted = squash(name);
  return fields.find((field) => squash(field.key) === wanted || squash(field.label) === wanted)?.key ?? null;
}

// --- Frontmatter: a small YAML subset -------------------------------------
// Supported: `key: value`, quoted strings, inline [a, b] lists, block lists,
// one nested map level, `|` block text and full-line # comments.
function withoutComment(raw) {
  let quoted = null;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (quoted === '"' && char === '\\') { index++; continue; }
    if (quoted) {
      if (char === quoted) {
        if (quoted === "'" && raw[index + 1] === "'") index++;
        else quoted = null;
      }
    } else if (char === '"' || char === "'") quoted = char;
    else if (char === '#' && (index === 0 || /\s/.test(raw[index - 1]))) return raw.slice(0, index).trimEnd();
  }
  return raw;
}
function scalar(raw) {
  const value = withoutComment(raw).trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error('Close the single-quoted text.');
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}
function inlineList(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items = []; let start = 0; let quoted = null;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];
    if (quoted === '"' && char === '\\') { index++; continue; }
    if (quoted) {
      if (char === quoted) {
        if (quoted === "'" && inner[index + 1] === "'") index++;
        else quoted = null;
      }
    } else if (char === '"' || char === "'") quoted = char;
    else if (char === ',') { items.push(scalar(inner.slice(start, index))); start = index + 1; }
  }
  items.push(scalar(inner.slice(start)));
  return items;
}
const indentOf = (line) => line.length - line.trimStart().length;
const blank = (line) => !line.trim() || line.trimStart().startsWith('#');

// YAML block text: `|` keeps one final newline, `|-` none, `|+` all of them.
function blockText(lines, start, parentIndent, chomp) {
  const taken = [];
  let index = start;
  while (index < lines.length && (!lines[index].trim() || indentOf(lines[index]) > parentIndent)) taken.push(lines[index++]);
  let trailing = 0;
  while (taken.length && !taken.at(-1).trim()) { taken.pop(); index--; trailing++; }
  const indent = Math.min(...taken.filter((line) => line.trim()).map(indentOf));
  const text = taken.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
  const ending = !text ? '' : chomp === '-' ? '' : chomp === '+' ? '\n'.repeat(trailing + 1) : '\n';
  return { value: text + ending, next: chomp === '+' ? index + trailing : index };
}

function parseValue(lines, index, rest, indent) {
  const value = withoutComment(rest).trim();
  if (value === '|' || value === '|-' || value === '|+') return blockText(lines, index + 1, indent, value[1] ?? '');
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new Error('Close the [list].');
    return { value: inlineList(value), next: index + 1 };
  }
  if (value) return { value: scalar(value), next: index + 1 };
  // An empty value introduces an indented list or map, or means "nothing".
  let next = index + 1;
  while (next < lines.length && blank(lines[next])) next++;
  if (next >= lines.length || indentOf(lines[next]) <= indent) return { value: '', next: index + 1 };
  const childIndent = indentOf(lines[next]);
  if (lines[next].trimStart().startsWith('- ') || lines[next].trim() === '-') {
    const list = [];
    while (next < lines.length && (blank(lines[next]) || indentOf(lines[next]) >= childIndent)) {
      if (blank(lines[next])) { next++; continue; }
      const item = lines[next].trim();
      if (!item.startsWith('-')) throw Object.assign(new Error('Write every list item as “- value”.'), { line: next });
      list.push(scalar(item.slice(1)));
      next++;
    }
    return { value: list, next };
  }
  const map = {};
  while (next < lines.length && (blank(lines[next]) || indentOf(lines[next]) >= childIndent)) {
    if (blank(lines[next])) { next++; continue; }
    if (indentOf(lines[next]) !== childIndent) throw Object.assign(new Error('Indent nested settings evenly.'), { line: next });
    const match = lines[next].trim().match(/^([^:]+):([\s\S]*)$/);
    if (!match) throw Object.assign(new Error('Write nested settings as “name: value”.'), { line: next });
    const child = parseValue(lines, next, match[2], childIndent);
    if (typeof child.value !== 'string') throw Object.assign(new Error('Nested settings hold text values.'), { line: next });
    map[match[1].trim()] = child.value;
    next = child.next;
  }
  return { value: map, next };
}

// Returns { data, body, errors }. A document without frontmatter is all body.
export function parseDocument(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n(?:([\s\S]*?)\n)?---(?:\n|$)/);
  if (!match) {
    if (normalized.startsWith('---\n')) return { data: {}, body: normalized, errors: ['Close the settings block with a line containing only ---.'] };
    return { data: {}, body: normalized, errors: [] };
  }
  const lines = (match[1] ?? '').split('\n');
  // A leading Markdown horizontal rule followed by prose is still a body.
  if (lines.some((line) => !blank(line)) && !lines.some((line) => /^\s*[A-Za-z_][\w-]*:/.test(line))) return { data: {}, body: normalized, errors: [] };
  const data = {}; const errors = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (blank(line)) { index++; continue; }
    if (indentOf(line)) { errors.push(`Line ${index + 2}: unexpected indentation.`); index++; continue; }
    const pair = line.match(/^([A-Za-z_][\w-]*):([\s\S]*)$/);
    if (!pair) { errors.push(`Line ${index + 2}: write settings as “name: value”.`); index++; continue; }
    try {
      const parsed = parseValue(lines, index, pair[2], 0);
      data[pair[1]] = parsed.value;
      index = parsed.next;
    } catch (error) {
      errors.push(`Line ${(error.line ?? index) + 2}: ${error instanceof SyntaxError ? 'invalid quoted text.' : error.message}`);
      index = (error.line ?? index) + 1;
      while (index < lines.length && (blank(lines[index]) || indentOf(lines[index]))) index++;
    }
  }
  return { data, body: normalized.slice(match[0].length), errors };
}

function quote(value) {
  if (value === '') return '""';
  if (/^[\s]|[\s]$|^[[\]{}"'|>#&*!%@`,?:-]|: | #|[,\r\u2028\u2029]/.test(value)) return JSON.stringify(value);
  return value;
}
// Several lines are written as block text when that reads back exactly;
// otherwise as quoted JSON text, which always does.
function textValue(value, indent) {
  if (!value.includes('\n')) return ` ${quote(value)}`;
  const body = value.replace(/\n+$/, '');
  const trailing = value.length - body.length;
  const lines = body.split('\n');
  const exact = body.trim() && !/^\s/.test(lines.find((line) => line.trim()) ?? '') && lines.every((line) => line === line.trimEnd()) && !value.includes('\r');
  if (!exact) return ` ${JSON.stringify(value)}`;
  const pad = ' '.repeat(indent + 2);
  const chomp = trailing === 0 ? '|-' : trailing === 1 ? '|' : '|+';
  return ` ${chomp}\n${lines.map((line) => (line ? pad + line : '')).join('\n')}${chomp === '|+' ? '\n'.repeat(trailing - 1) : ''}`;
}
// Writes settings in a stable order, followed by the Markdown body.
export function serializeDocument(data, body) {
  const order = [...knownKeys.filter((key) => key in data), ...Object.keys(data).filter((key) => !knownKeys.includes(key))];
  const lines = [];
  for (const key of order) {
    const value = data[key];
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(quote).join(', ')}]`);
    else if (value && typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [child, text] of Object.entries(value)) lines.push(`  ${child}:${textValue(text, 2)}`);
    } else lines.push(`${key}:${textValue(String(value), 0)}`);
  }
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

// --- Lane playbook settings ------------------------------------------------
const listOf = (value) => (Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? value.split(',').map((item) => item.trim()) : []);

// Resolves a parsed lane playbook against a card template. Problems that
// would make a run misbehave are errors; unknown settings are warnings.
export function playbookSettings(document, templateId) {
  const { data, body } = document;
  const errors = [...document.errors]; const warnings = [];
  const fields = setFields(templateId); const readable = contextFields(templateId);
  for (const key of Object.keys(data)) if (!knownKeys.includes(key)) warnings.push(`Unknown setting “${key}” is ignored.`);
  const run = data.run === undefined || data.run === '' ? 'on-enter' : String(data.run).toLowerCase();
  if (!runModes.includes(run)) errors.push(`run must be ${runModes.join(', ')}.`);
  const provider = data.provider ? String(data.provider).toLowerCase() : null;
  if (provider && !providers.includes(provider)) errors.push('provider must be codex or claude.');
  const model = data.model ? String(data.model).trim() : null;
  if (model && model.length > 200) errors.push('model can be up to 200 characters.');
  const conversation = data.conversation ? String(data.conversation).toLowerCase() : 'continue';
  if (!conversationModes.includes(conversation)) errors.push('conversation must be continue or fresh.');

  let selections = { fields: readable.map((field) => field.key), roles: ['original', 'inspiration'] };
  if (data.context !== undefined) {
    selections = { fields: [], roles: [] };
    for (const name of listOf(data.context)) {
      const role = roleNames[squash(name)];
      const key = role ? null : fieldKey(readable, name);
      if (role) { if (!selections.roles.includes(role)) selections.roles.push(role); }
      else if (key) { if (!selections.fields.includes(key)) selections.fields.push(key); }
      else errors.push(`context: “${name}” is not a card field or image (original, inspiration, display).`);
    }
  }
  const mayEdit = [];
  for (const name of listOf(data.may_edit)) {
    const key = fieldKey(readable, name);
    if (key) { if (!mayEdit.includes(key)) mayEdit.push(key); }
    else errors.push(`may_edit: “${name}” is not an editable card field.`);
  }
  const set = {};
  if (data.set !== undefined && data.set !== '') {
    if (!data.set || typeof data.set !== 'object' || Array.isArray(data.set)) errors.push('set needs one “field: value” per line.');
    else for (const [name, value] of Object.entries(data.set)) {
      const key = fieldKey(fields, name);
      const field = fields.find((item) => item.key === key);
      if (!field) errors.push(`set: “${name}” is not a card field.`);
      else if (value.length > field.max) errors.push(`set: ${field.label} can be up to ${field.max.toLocaleString('en-US')} characters.`);
      else set[key] = value;
    }
  }
  const skills = [];
  for (const name of [...listOf(data.skills), ...[...body.matchAll(/skills\/([a-z0-9][a-z0-9_-]{0,79})\.md/gi)].map((m) => m[1])]) {
    const clean = String(name).replace(/^skills\//i, '').replace(/\.md$/i, '');
    if (!skillName.test(clean)) errors.push(`skills: “${name}” is not a valid skill name.`);
    else if (!skills.includes(clean)) skills.push(clean);
  }
  return { lane: data.lane ? String(data.lane) : null, run, provider, model, conversation, selections, mayEdit, set, skills,
    instructions: body.trim(), errors, warnings };
}

// One sentence for the board and editor, e.g. "Runs on entry · Claude · may edit Title Options".
export function describeSettings(settings, templateId) {
  if (settings.errors.length) return 'Has errors';
  const label = (key) => setFields(templateId).find((field) => field.key === key)?.label ?? key;
  const parts = [];
  if (settings.instructions && settings.run !== 'off') parts.push(settings.run === 'on-enter' ? 'Runs on entry' : 'Runs when you choose');
  else parts.push('No agent run');
  if (settings.instructions && settings.run !== 'off') parts.push(settings.provider === 'claude' ? 'Claude' : settings.provider === 'codex' ? 'Codex' : 'Card chat provider');
  if (settings.mayEdit.length) parts.push(`may edit ${settings.mayEdit.map(label).join(', ')}`);
  const set = Object.keys(settings.set);
  if (set.length) parts.push(`sets ${set.map(label).join(', ')}`);
  return parts.join(' · ');
}

// --- Starter documents -----------------------------------------------------
export function mapTemplate(projectName, lanes) {
  return `# ${projectName} — project map

Every lane run reads this file first. Describe what this project is for and how the lanes fit together, so an agent always knows where it is.

## What we make

(Describe the project: the audience, the format, the voice.)

## Lanes, in order

${lanes.map((lane, index) => `${index + 1}. **${lane.name}** — (what happens here)`).join('\n')}

## Card fields

- **Title Options**: candidate titles, one per line
- **Intro**: the opening hook
- **Script**: the full script

## Rules for every lane

- Read the card's hand-off notes before starting.
- Keep earlier work unless the playbook says to replace it.
`;
}
export function playbookTemplate(lane) {
  return serializeDocument({ lane: lane.id, run: 'on-enter', may_edit: [] }, `# ${lane.name}

What should happen when a card enters this lane?

1. Read the card's hand-off notes.
2. (Do the work. Mention skills/<name>.md to include a skill.)
3. Put the results in the fields this lane may edit.

## Done when

- (How you know this lane's work is finished.)
`);
}
export function skillTemplate(name) {
  return `# ${name}

(Know-how that several lanes share: a voice guide, a checklist, examples.)
`;
}

// --- Lane run prompt and result -------------------------------------------
export const resultTag = 'frameboard-result';

export function composeLanePrompt({ projectName, laneName, lanes, trigger = 'enter', map, playbook, skills = [], notes = '', settings, templateId }) {
  const fields = setFields(templateId).filter((field) => field.key !== 'prompt');
  const label = (key) => fields.find((field) => field.key === key)?.label ?? key;
  const trimmedNotes = notes.length > notesInPrompt ? `…(earlier notes omitted)\n${notes.slice(-notesInPrompt)}` : notes;
  const sections = [
    `You are working on one card in the Frameboard project “${projectName}”. ${trigger === 'manual' ? `The user asked you to run the “${laneName}” lane playbook for it.` : `The card just entered the “${laneName}” lane.`} Follow that lane's playbook below.`,
    map?.text.trim() ? `## Project map (${map.path})\n\n${map.text.trim()}` : '',
    `## Lane playbook: ${laneName} (${playbook.path})\n\n${settings.instructions}`,
    ...skills.map((skill) => (skill.text === null ? `## Skill ${skill.name}\n\n(skills/${skill.name}.md does not exist yet.)` : `## Skill: ${skill.name} (${skill.path})\n\n${skill.text.trim()}`)),
    `## Hand-off notes (notes.md)\n\n${trimmedNotes.trim() || 'No notes yet. This is the first lane run that leaves notes for this card.'}`,
    'Every photo in the card gallery is attached to this run. Use the current image references listed below to identify the available portraits, backgrounds and thumbnails. Hand-off notes describe earlier runs; check these attachments before treating a photo as missing.',
    `## Reporting your result

When you finish, end your reply with exactly one fenced code block tagged \`${resultTag}\` that contains JSON:

\`\`\`${resultTag}
{
  "fields": { "titleOptions": "the complete new value" },
  "notes": "a short hand-off for whoever works on this card next",
  "move": "Lane name"
}
\`\`\`

- Field keys: ${fields.map((field) => `${field.key} (${field.label})`).join(', ')}.
- A value replaces the whole field. Leave out fields you did not change.
- ${settings.mayEdit.length ? `Frameboard applies ${settings.mayEdit.map(label).join(', ')} directly.` : 'This lane may not edit fields directly.'} Every other field becomes a proposal the user reviews.
- Include "move" only if the playbook tells you to propose a move. Moves always wait for the user. Lanes: ${lanes.map((lane) => lane.name).join(', ')}.
- Always include "notes": what you did, decisions made and anything still open.
- Report through this block only. Do not call Frameboard card tools or edit notes.md yourself during a lane run.`,
  ];
  return sections.filter(Boolean).join('\n\n');
}

// The last result block in a reply. Missing blocks are not errors; a block
// that cannot be read is.
export function parseLaneResult(text, templateId) {
  const blocks = [...String(text ?? '').matchAll(/^```[ \t]*frameboard(?:-result)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?=\r?$)/gm)];
  if (!blocks.length) return null;
  let value;
  try { value = JSON.parse(blocks.at(-1)[1]); } catch (error) { return { fields: {}, notes: '', move: null, errors: [`The result block is not valid JSON: ${error.message}`] }; }
  const result = { fields: {}, notes: '', move: null, errors: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...result, errors: ['The result block must be a JSON object.'] };
  const fields = setFields(templateId).filter((field) => field.key !== 'prompt');
  if (value.fields !== undefined) {
    if (!value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)) result.errors.push('“fields” must be an object of text values.');
    else for (const [name, fieldValue] of Object.entries(value.fields)) {
      const key = fieldKey(fields, name);
      const field = fields.find((item) => item.key === key);
      if (!field) result.errors.push(`Ignored unknown field “${name}”.`);
      else if (typeof fieldValue !== 'string') result.errors.push(`Ignored ${field.label}: its value must be text.`);
      else if (fieldValue.length > field.max) result.errors.push(`Ignored ${field.label}: it is longer than ${field.max.toLocaleString('en-US')} characters.`);
      else result.fields[key] = fieldValue;
    }
  }
  if (value.notes !== undefined) {
    if (typeof value.notes === 'string') result.notes = value.notes.slice(0, 50000);
    else result.errors.push('Ignored “notes”: it must be text.');
  }
  if (value.move !== undefined && value.move !== null && value.move !== '') {
    if (typeof value.move === 'string') result.move = value.move.trim();
    else result.errors.push('Ignored “move”: it must be a lane name.');
  }
  return result;
}
export const imageRoleLabel = (role) => roleLabels[role] ?? role;
