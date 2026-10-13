// Card templates describe the text fields and image roles a card carries.
// Templates are rows in the database (card_templates); this module holds the
// pure functions over a template definition that the browser and the server
// share: validation, the field lists each feature reads, and the built-in
// template every workspace starts with. Nothing here reads storage.
//
// A definition is { id, name, title: { label, max }, fields: [...], imageRoles: [...] }.
// Field: { key, label, control: 'text' | 'textarea' | 'url', max, placeholder?,
//   placement?: 'header', copy?: true, countWords?: true, editor?: false,
//   youtube?: true, videoLabel? }. Keys are the identity of a field: labels
// can change, keys never do, because card values are stored by key.
// Image role: { key, label }. The display image is always role "cover".

export const controls = ['text', 'textarea', 'url'];
export const fieldKeyPattern = /^[a-z][A-Za-z0-9]{0,59}$/;
export const roleKeyPattern = /^[a-z][a-z0-9]{0,29}$/;
export const templateIdPattern = /^[a-z0-9][a-z0-9-]{0,59}$/;
// Names a card already uses, that playbooks and chats treat specially, or
// whose editor input id (card-<key>, <key>-count) would collide with the
// editor's own elements. Compared squashed (lowercase, letters and digits).
export const reservedFieldKeys = ['title', 'images', 'imageroles', 'placement', 'id', 'template', 'notes', 'move', 'outputs', 'fields', 'cover', 'display',
  'lane', 'chat', 'dialog', 'playbook', 'image', 'total', 'library'];
// Card content saved beside its template fields rather than in them.
export const cardContentKeys = ['title', 'images', 'imageRoles', 'library'];
export const maxFields = 50;
export const maxImageRoles = 10;
export const maxFieldLength = 1000000;
export const maxTemplateJson = 100000;
const defaultMax = { text: 500, url: 4096, textarea: 200000 };

// The template every workspace starts with. The database row is the source
// of truth once seeded; this copy seeds new workspaces and offers a reset.
export const youtubeVideoTemplate = Object.freeze({
  id: 'youtube-video',
  name: 'YouTube video',
  title: { label: 'Card title', max: 500 },
  fields: [
    { key: 'originalVideoUrl', label: 'Original URL', max: 4096, control: 'url', placement: 'header', videoLabel: 'original video', youtube: true, placeholder: 'Paste a YouTube link…' },
    { key: 'titleOptions', label: 'Title Options', max: 200000, control: 'textarea', placeholder: 'Brainstorm titles here, one idea per line…' },
    { key: 'intro', label: 'Intro', max: 200000, control: 'textarea', copy: true, placeholder: "What's the hook? Start with the idea that pulls people in…" },
    { key: 'script', label: 'Script', max: 1000000, control: 'textarea', countWords: true, copy: true, placeholder: 'Make room for the full story. Write your script here…' },
    // Prompt is set with Set prompt or lane playbooks and used by Trifecta copy; the editor doesn't show it.
    { key: 'prompt', label: 'Prompt', max: 200000, control: 'textarea', editor: false },
    { key: 'publishedVideoUrl', label: 'Published video URL', max: 4096, control: 'url', videoLabel: 'published video', placeholder: 'https://…' },
    { key: 'originalVideoTitle', label: 'Original video title', max: 500, control: 'text', placeholder: 'The video that inspired this idea…' },
  ],
  imageRoles: [{ key: 'original', label: 'Original' }, { key: 'inspiration', label: 'Inspiration' }],
});
export const builtinTemplates = Object.freeze({ [youtubeVideoTemplate.id]: youtubeVideoTemplate });

export const fieldInputId = (key) => `card-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
// A camelCase key from a label, e.g. "Original URL" → originalUrl.
export function fieldKeyFrom(label) {
  const words = String(label).normalize('NFKD').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const key = words.map((word, index) => (index ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase())).join('').slice(0, 60);
  return /^[a-z]/.test(key) ? key : key ? `f${key}`.slice(0, 60) : '';
}
export function templateSlug(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'template';
}

const isText = (value, max) => typeof value === 'string' && value.length <= max;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Checks a definition as the editor or API submits it. Returns the normalized
// definition (defaults filled, unknown keys dropped) and user-facing errors.
// Keys of existing fields cannot change: `locked` lists keys that cards use.
export function validateTemplate(input, { locked = [] } = {}) {
  const errors = [];
  if (!isObject(input)) return { template: null, errors: ['Invalid card template.'] };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100) errors.push('Templates need a name (up to 100 characters).');
  const titleInput = isObject(input.title) ? input.title : {};
  const titleLabel = typeof titleInput.label === 'string' && titleInput.label.trim() ? titleInput.label.trim().slice(0, 100) : 'Card title';
  const titleMax = titleInput.max === undefined ? 500 : titleInput.max;
  if (!Number.isInteger(titleMax) || titleMax < 1 || titleMax > 10000) errors.push('The title limit must be between 1 and 10,000 characters.');
  const fields = []; const keys = new Set();
  if (!Array.isArray(input.fields)) errors.push('Fields must be a list.');
  else if (input.fields.length > maxFields) errors.push(`A template can hold up to ${maxFields} fields.`);
  else for (const [index, raw] of input.fields.entries()) {
    const at = `Field ${index + 1}`;
    if (!isObject(raw)) { errors.push(`${at}: invalid field.`); continue; }
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    const key = typeof raw.key === 'string' && raw.key ? raw.key : fieldKeyFrom(label);
    const where = label ? `“${label}”` : at;
    if (!label || label.length > 100) errors.push(`${at}: fields need a label (up to 100 characters).`);
    if (!fieldKeyPattern.test(key)) errors.push(`${where}: its key must start with a letter and use letters and numbers only (camelCase, up to 60 characters).`);
    else if (reservedFieldKeys.includes(squash(key))) errors.push(`${where}: the key “${key}” is reserved.`);
    else if (keys.has(key)) errors.push(`${where}: another field already uses the key “${key}”.`);
    keys.add(key);
    const control = raw.control === undefined ? 'text' : raw.control;
    if (!controls.includes(control)) errors.push(`${where}: control must be text, textarea or url.`);
    const max = raw.max === undefined ? defaultMax[control] ?? 500 : raw.max;
    if (!Number.isInteger(max) || max < 1 || max > maxFieldLength) errors.push(`${where}: the maximum length must be between 1 and ${maxFieldLength.toLocaleString('en-US')} characters.`);
    if (raw.placeholder !== undefined && !isText(raw.placeholder, 500)) errors.push(`${where}: placeholders can be up to 500 characters.`);
    if (raw.placement !== undefined && raw.placement !== null && raw.placement !== 'header') errors.push(`${where}: placement must be header or left out.`);
    if (raw.videoLabel !== undefined && !isText(raw.videoLabel, 100)) errors.push(`${where}: the video label can be up to 100 characters.`);
    for (const flag of ['copy', 'countWords', 'youtube']) if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') errors.push(`${where}: ${flag} must be true or false.`);
    if (raw.editor !== undefined && raw.editor !== true && raw.editor !== false) errors.push(`${where}: editor must be true or false.`);
    if (raw.youtube && control !== 'url') errors.push(`${where}: only a url field can fetch from YouTube.`);
    const field = { key, label, control, max };
    if (raw.placeholder) field.placeholder = raw.placeholder;
    if (raw.placement === 'header') field.placement = 'header';
    if (raw.copy) field.copy = true;
    if (raw.countWords) field.countWords = true;
    if (raw.editor === false) field.editor = false;
    if (raw.youtube) field.youtube = true;
    if (raw.videoLabel) field.videoLabel = raw.videoLabel;
    fields.push(field);
  }
  for (const key of locked) if (!keys.has(key)) errors.push(`The field “${key}” is used by existing cards and cannot be removed. Hide it from the editor instead.`);
  const imageRoles = []; const roleKeys = new Set();
  if (!Array.isArray(input.imageRoles ?? [])) errors.push('Image roles must be a list.');
  else if ((input.imageRoles ?? []).length > maxImageRoles) errors.push(`A template can hold up to ${maxImageRoles} image roles.`);
  else for (const [index, raw] of (input.imageRoles ?? []).entries()) {
    // Earlier definitions listed role keys as plain strings.
    const role = typeof raw === 'string' ? { key: raw, label: raw ? raw[0].toUpperCase() + raw.slice(1) : '' } : raw;
    const at = `Image role ${index + 1}`;
    if (!isObject(role)) { errors.push(`${at}: invalid image role.`); continue; }
    const label = typeof role.label === 'string' ? role.label.trim() : '';
    const key = typeof role.key === 'string' && role.key ? role.key : fieldKeyFrom(label).toLowerCase();
    if (!label || label.length > 50) errors.push(`${at}: image roles need a label (up to 50 characters).`);
    if (!roleKeyPattern.test(key)) errors.push(`${at}: its key must be lowercase letters and numbers (up to 30 characters).`);
    else if (['cover', 'display'].includes(key)) errors.push(`${at}: “cover” is the display image, which every card has.`);
    else if (roleKeys.has(key)) errors.push(`${at}: another image role already uses the key “${key}”.`);
    roleKeys.add(key);
    imageRoles.push({ key, label });
  }
  // Playbooks name fields and roles loosely, by key or label, so no two may
  // read the same once squashed; the title and the display image count too.
  // Owners are identities (a key), so two fields with one label collide too.
  // Each pair of colliding owners is reported once, whichever names collide.
  const owners = new Map([['title', { id: 'title', name: 'the card title' }],
    ['display', { id: 'cover', name: 'the display image' }], ['cover', { id: 'cover', name: 'the display image' }]]);
  const reported = new Set();
  const claim = (name, owner) => {
    const taken = owners.get(name);
    if (!taken) owners.set(name, owner);
    else if (taken.id !== owner.id && !reported.has(`${owner.id}|${taken.id}`)) {
      reported.add(`${owner.id}|${taken.id}`);
      errors.push(`${owner.name[0].toUpperCase()}${owner.name.slice(1)} reads the same as ${taken.name} in playbook settings. Use a distinct name.`);
    }
  };
  claim(squash(titleLabel), { id: 'title', name: 'the card title' });
  for (const field of fields) for (const name of new Set([squash(field.key), squash(field.label)])) claim(name, { id: `field:${field.key}`, name: `the field “${field.label}”` });
  for (const role of imageRoles) for (const name of new Set([squash(role.key), squash(role.label)])) claim(name, { id: `role:${role.key}`, name: `the image role “${role.label}”` });
  const template = { name, title: { label: titleLabel, max: titleMax }, fields, imageRoles };
  if (JSON.stringify(template).length > maxTemplateJson) errors.push('This template is too large.');
  return { template: errors.length ? null : template, errors };
}

// --- Field lists each feature reads --------------------------------------
export function emptyFields(template) {
  return Object.fromEntries(template.fields.map((field) => [field.key, '']));
}
export function emptyImageRoles(template) {
  return Object.fromEntries(['cover', ...template.imageRoles.map((role) => role.key)].map((role) => [role, null]));
}
// Every field a value can be set for: the title and all fields, hidden ones too.
export function setFields(template) {
  return [{ key: 'title', ...template.title, control: 'text' }, ...template.fields];
}
// Fields the card editor shows and search reads.
export function editorFields(template) {
  return template.fields.filter((field) => field.editor !== false);
}
// Fields a chat or lane run can send, edit or report: hidden fields such as
// a shared prompt are left out because every card tends to share them.
export function contextFields(template) {
  return [{ key: 'title', label: template.title.label }, ...editorFields(template)];
}
// The template's image roles, then the display image every card has.
// "display" is the playbook word for the cover role.
export function imageRoles(template) {
  return [...template.imageRoles.map((role) => ({ key: role.key, label: role.label, aliases: [] })), { key: 'cover', label: 'Display', aliases: ['display'] }];
}
export function roleLabel(template, role) {
  return imageRoles(template).find((entry) => entry.key === role)?.label ?? role;
}
// Field keys may be written as camelCase, snake_case or their label.
export const squash = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
export function fieldKey(fields, name) {
  const wanted = squash(name);
  return fields.find((field) => squash(field.key) === wanted || squash(field.label) === wanted)?.key ?? null;
}
export function roleKey(template, name) {
  const wanted = squash(name);
  return imageRoles(template).find((role) => squash(role.key) === wanted || squash(role.label) === wanted || role.aliases.some((alias) => squash(alias) === wanted))?.key ?? null;
}
// Stored cards keep values for fields a template no longer has; reads fill
// in the fields and roles it has gained since, so every template key exists.
export function normalizeCard(template, card) {
  return { ...card, fields: { ...emptyFields(template), ...card.fields }, imageRoles: { ...emptyImageRoles(template), ...card.imageRoles } };
}
