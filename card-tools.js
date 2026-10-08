// Registration is frozen with configuration; routing supplies card/attempt IDs.
const fields = { type: 'object', minProperties: 1, additionalProperties: { type: 'string' } };
const baseVersions = { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } };
const spec = (name, description, properties, required = []) => ({ type: 'function', name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } });
export const cardTools = [
  spec('read_card', 'Read your originating card and its current field/placement versions. Reading does not grant edit authority.', {}),
  spec('edit_fields', 'Edit explicitly authorized text fields. Newer or dirty fields and unauthorized suggestions become proposals. Supply versions you actually used.', { fields, baseVersions }, ['fields']),
  spec('propose_changes', 'Suggest text changes for explicit user acceptance, without editing the card.', { fields, baseVersions }, ['fields']),
  spec('propose_move', 'Propose moving this card to a lane in its project. Always requires user acceptance.', { toStageId: { type: 'string' } }, ['toStageId']),
  spec('register_image', 'Retain a rendered image inside this card workspace as a chat output. Does not adopt it or change image roles.', { path: { type: 'string' }, name: { type: 'string' } }, ['path']),
];
