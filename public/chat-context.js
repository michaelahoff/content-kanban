// Shared selection vocabulary. Values and image versions are resolved on the
// server at queue time, never from the browser's unsaved card draft.
import { templates } from './card-template.js';

export function contextFields(template) {
  return [{ key: 'title', label: 'Card title' }, ...templates[template].fields.filter((field) => field.key !== 'prompt')];
}
export function defaultSelections(template) {
  return { fields: contextFields(template).map((field) => field.key), roles: ['original', 'inspiration'], images: [] };
}
export function selectedContext(card, selections, versions) {
  const fields = selections.fields.map((key) => ({ key, label: contextFields(card.template).find((field) => field.key === key).label,
    value: key === 'title' ? card.title : card.fields[key], version: versions[key] }));
  const images = new Map();
  function add(id, label) {
    if (!id) return;
    const image = card.images.find((image) => image.id === id);
    if (!image) throw Object.assign(new Error('A selected image is no longer in this card. Review its references before sending.'), { status: 409 });
    if (!images.has(id)) images.set(id, { id, name: image.name, labels: [] });
    images.get(id).labels.push(label);
  }
  for (const role of selections.roles) add(card.imageRoles[role], { original: 'Original', inspiration: 'Inspiration', cover: 'Display' }[role]);
  for (const id of selections.images) add(id, 'Attachment');
  return { fields, images: [...images.values()] };
}
export function submissionText(submission) {
  return `${submission.prompt}\n\nCard text-edit authority: ${submission.authority.fields.length ? submission.authority.fields.join(', ') : 'none; suggest changes as proposals'}. Use edit_fields only for explicitly requested edits in that scope. Suggestions, lane moves, image adoption and image roles require acceptance.\n\nSubmitted card context:\n${submission.context.fields.map((field) => `${field.label} (field ${field.key}, version ${field.version}):\n${field.value}`).join('\n\n')}${submission.context.images.length ? `\n\nImage references:\n${submission.context.images.map((image) => `${image.labels.join(', ')}: ${image.name} (version ${image.id}, SHA-256 ${image.hash})`).join('\n')}` : ''}`;
}
