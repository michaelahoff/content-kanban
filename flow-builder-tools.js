// The flow builder: the agent role behind a project chat. It describes a
// process the user wants as flows, lanes, playbooks, templates and skills,
// through the tools below. This module is pure: the tool specifications
// (JSON Schema, as Codex dynamic tools and the Claude MCP server list them)
// and the guidance the agent receives. flow-builder.js implements the tools.
import { laneColors, flowKinds } from './store.js';
import { runModes, conversationModes, providers, advanceModes, actions } from './public/playbook-format.js';
import { controls } from './public/card-template.js';

const text = (description, extra = {}) => ({ type: 'string', description, ...extra });
const number = (description) => ({ type: 'number', description });
const list = (description, items = { type: 'string' }) => ({ type: 'array', description, items });
const map = (description) => ({ type: 'object', description, additionalProperties: { type: 'string' } });
const object = (description, properties, required = []) => ({ type: 'object', description, properties, required, additionalProperties: false });
const spec = (name, description, properties, required = []) => ({ type: 'function', name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } });

// A lane playbook as the builder writes it. Settings mirror the playbook
// frontmatter (public/playbook-format.js); instructions are its Markdown body.
export const playbookSchema = object('What happens when a card enters this lane: settings and the Markdown instructions its agent follows. Leave it out for a lane with no automation.', {
  run: text(`When the agent runs: ${runModes.join(', ')}. on-enter runs for every card that arrives, manual only when the user chooses Run playbook, off never (a human stage). Default on-enter.`, { enum: runModes }),
  provider: text(`Which agent runs this lane: ${providers.join(' or ')}. Omit to use the card chat's provider.`, { enum: providers }),
  model: text('A model ID from read_project. Omit for the provider default.'),
  conversation: text(`${conversationModes.join(' or ')}: continue the card chat (the agent remembers earlier lanes) or start fresh context for each run. Default continue.`, { enum: conversationModes }),
  context: list('Card fields and image roles to send, by key or label. Omit to send the title, every visible field and every image role.'),
  may_edit: list('Field keys the agent may change directly. Everything else it reports becomes a proposal the user reviews. Keep this to the fields this lane produces.'),
  set: map('Values applied the moment a card enters the lane, field key → text (hidden fields too). Use it for a brief or prompt that every card in the lane should carry.'),
  skills: list('Skill names (skills/<name>.md of this flow) to include in the prompt. Write them with the skills argument or write_skill.'),
  assets: list('Project Library sources to send with every run: asset:<id> or folder:<id>, exactly as read_project lists them.'),
  advance: text(`${advanceModes.join(' or ')}: when the agent chooses a route, auto moves the card at once and starts the next lane; review (default) proposes the move for the user.`, { enum: advanceModes }),
  routes: map('Ways out of this lane for a graph flow: route name → lane name (or ID). The agent picks one by name in its result; tell it when to choose each one in the instructions.'),
  creates: object('Let runs of this lane create new cards: in which lane of this flow, with which card template.', { lane: text('Lane name or ID of this flow.'), template: text('Card template ID or name.') }, ['lane', 'template']),
  action: text(`A lane action Frameboard performs itself instead of running an agent: ${actions.join(', ')}.`, { enum: actions }),
  publish: object('For action publish: where the card\'s saved outputs go.', { to: text('A site folder name served under /sites/<name>/, or user@host:/path for rsync.'), url: text('Where that site is served (optional).'), field: text('Card field that receives the published address (optional).') }, ['to']),
  template: text('Card template (ID or name) this lane\'s cards use when it is not the flow\'s: only for a lane that receives created cards of another template.'),
  instructions: text('Markdown instructions for the agent: what to do with the card, which fields to fill, what done looks like, and for a graph which route to choose when. Required when run is on-enter or manual and there is no action.'),
});

export const laneSchema = object('A lane (a node, in a graph flow). The first lane is where new cards start.', {
  name: text('Lane name (up to 100 characters).'),
  color: text(`One of ${laneColors.join(', ')}. Omit to pick one.`, { enum: laneColors }),
  x: number('Graph only: horizontal place on the canvas. Omit to lay nodes out automatically.'),
  y: number('Graph only: vertical place on the canvas.'),
  playbook: playbookSchema,
}, ['name']);

const fieldSchema = object('A text field of a card template.', {
  key: text('camelCase key, letters and numbers, starting with a letter. Omit to derive it from the label. Keys are permanent once cards hold values.'),
  label: text('Label shown in the card editor.'),
  control: text(`${controls.join(', ')}. textarea for anything longer than a line.`, { enum: controls }),
  max: { type: 'integer', description: 'Maximum length in characters (default 500 for text, 4096 for url, 200000 for textarea).' },
  placeholder: text('Placeholder text in the editor.'),
  placement: text('header puts a short field at the top of the card editor.', { enum: ['header'] }),
  copy: { type: 'boolean', description: 'Show a Copy button beside the field.' },
  countWords: { type: 'boolean', description: 'Show a word count.' },
  hidden: { type: 'boolean', description: 'Hide the field from the card editor, search and chats; playbooks can still set it (a brief, a prompt).' },
  youtube: { type: 'boolean', description: 'url field whose YouTube video is looked up for the card title, thumbnail and transcript.' },
  transcript: { type: 'boolean', description: 'textarea that receives the YouTube transcript (one per template).' },
  videoLabel: text('For url fields: what the link is called (e.g. original video).'),
}, ['label']);
const imageRoleSchema = object('A named image slot on the card, such as Original or Inspiration.', { key: text('Lowercase key; omit to derive it from the label.'), label: text('Label.') }, ['label']);
const templateProperties = {
  name: text('Template name (up to 100 characters).'),
  title: object('The card title field.', { label: text('Label for the title (default Card title).'), max: { type: 'integer', description: 'Maximum title length (default 500).' } }),
  fields: list('Text fields, in editor order.', fieldSchema),
  imageRoles: list('Image roles the card offers besides its display image.', imageRoleSchema),
};

export const builderTools = [
  spec('read_project', 'The project as it is now: its flows with their lanes (IDs, colors, places on the canvas and who placed them, card counts and playbook summaries with routes), every card template with its field keys, the Library files it can send to lanes (as asset:<id> and folder:<id>), and the available providers and models. Read this before changing anything you have not just created.', {}),
  spec('read_flow', 'One flow in full: its flow map, each lane\'s playbook text with its settings as Frameboard reads them and any errors, and its skills.', { flowId: text('Flow ID from read_project.') }, ['flowId']),
  spec('read_template', 'One card template\'s full definition.', { templateId: text('Template ID.') }, ['templateId']),
  spec('create_flow', 'Create a whole flow in one call: its lanes in order (the first is where cards start), each lane\'s playbook, the flow map and any skills. With flowId it instead rebuilds an existing flow that holds no cards (a project\'s untouched starter flow, for example): its lanes and playbooks are replaced, its name, kind and template updated. Routes and creates.lane name lanes of this same call by name. Everything is checked before anything is created, so a problem means nothing changed.', {
    flowId: text('Rebuild this empty flow instead of creating a new one.'),
    name: text('Flow name (required for a new flow).'),
    kind: text(`${flowKinds.join(' or ')}. A board is a line of lanes a card moves along; a graph is nodes joined by named routes that can branch and loop.`, { enum: flowKinds }),
    templateId: text('Card template for the flow\'s new cards (ID or name). Default: the workspace default template.'),
    lanes: list('The lanes in order. The first lane is the start lane.', laneSchema),
    map: text('The flow map (MAP.md): what this flow produces, for whom, in what voice, and what each lane does. Every lane run reads it first, so write it. Omit to get a generated outline.'),
    skills: map('Skills to write, name → Markdown. A skill is know-how lanes share (a voice guide, a checklist, an example).'),
  }, ['lanes']),
  spec('update_flow', 'Rename a flow, change the card template its new cards use, or turn a board into a graph (lanes become nodes in a line) or a graph into a board (routes and layout are removed).', { flowId: text('Flow ID.'), name: text('New name.'), templateId: text('Template ID or name.'), kind: text(`${flowKinds.join(' or ')}.`, { enum: flowKinds }) }, ['flowId']),
  spec('delete_flow', 'Delete a flow that holds no cards. A project keeps at least one flow.', { flowId: text('Flow ID.') }, ['flowId']),
  spec('create_lane', 'Add one lane (node) to a flow, with its playbook. Without x and y a graph node goes one column before the nodes its routes lead to (after the last column when it has none), in a free row; call layout_flow afterwards so the whole canvas reads left to right again.', { flowId: text('Flow ID.'), name: text('Lane name.'), color: text(`One of ${laneColors.join(', ')}.`, { enum: laneColors }), x: number('Graph only: canvas x.'), y: number('Graph only: canvas y.'), position: { type: 'integer', description: 'Place among the flow\'s lanes, 0 first. Default: last.' }, playbook: playbookSchema }, ['flowId', 'name']),
  spec('update_lane', 'Rename, recolor, move or reposition a lane. Position 0 makes it the start lane. Graph nodes sit on a grid 380 apart across and 230 apart down, from x 0 and y 40.', { laneId: text('Lane ID.'), name: text('New name.'), color: text(`One of ${laneColors.join(', ')}.`, { enum: laneColors }), x: number('Canvas x.'), y: number('Canvas y.'), position: { type: 'integer', description: 'Place among the flow\'s lanes, 0 first.' } }, ['laneId']),
  spec('layout_flow', 'Place every node of a graph flow from its routes: columns left to right along the longest path from the start node, branches in rows beside the nodes that lead to them, loops ignored. Call it after adding, removing or rerouting nodes so the canvas reads cleanly again. Nodes the user placed by hand (placedBy: user in read_project) are kept unless rearrange is true; ask before passing it, unless the user asked you to reorganize.', { flowId: text('Flow ID.'), rearrange: { type: 'boolean', description: 'Also move nodes the user placed by hand.' } }, ['flowId']),
  spec('delete_lane', 'Delete a lane and its playbook. A lane that holds cards is only deleted when moveCardsTo names another lane to move them to first; otherwise ask the user.', { laneId: text('Lane ID.'), moveCardsTo: text('Lane ID (same project) that receives the lane\'s cards.') }, ['laneId']),
  spec('write_playbook', 'Replace a lane\'s playbook: the settings given become its whole settings block (settings you leave out are removed), and instructions replace its body (omit instructions to keep the current ones). Read the flow first when editing, so nothing the user wrote is lost. Refused with the problems when the settings do not fit the card template.', { laneId: text('Lane ID.'), playbook: playbookSchema }, ['laneId', 'playbook']),
  spec('set_routes', 'Replace a lane\'s routes (and optionally its advance setting) without touching the rest of its playbook.', { laneId: text('Lane ID.'), routes: map('Route name → lane name or ID of the same flow.'), advance: text(`${advanceModes.join(' or ')}.`, { enum: advanceModes }) }, ['laneId', 'routes']),
  spec('write_map', 'Replace a flow\'s flow map (MAP.md), which every lane run reads first.', { flowId: text('Flow ID.'), text: text('The complete Markdown.') }, ['flowId', 'text']),
  spec('write_skill', 'Write or replace a skill of a flow (skills/<name>.md). Playbooks include it with skills: [name].', { flowId: text('Flow ID.'), name: text('Skill name: letters, numbers, - and _.'), text: text('The complete Markdown.') }, ['flowId', 'name', 'text']),
  spec('delete_skill', 'Delete a skill file of a flow.', { flowId: text('Flow ID.'), name: text('Skill name.') }, ['flowId', 'name']),
  spec('create_template', 'Create a card template: the text fields and image roles its cards carry. Create one when the built-in YouTube video template does not fit the process.', templateProperties, ['name', 'fields']),
  spec('update_template', 'Replace a card template\'s definition. Give the complete field list: a field cards hold values in keeps its key (read_template first). New fields are added to every card of the template.', { templateId: text('Template ID.'), ...templateProperties }, ['templateId', 'fields']),
  spec('delete_template', 'Delete a card template no card and no flow uses.', { templateId: text('Template ID.') }, ['templateId']),
  spec('create_cards', 'Create cards in a lane, for example an example card to try the flow with. Each card gets the lane\'s set: values; creating a card never starts an agent.', { laneId: text('Lane ID.'), cards: list('Up to 50 cards.', object('A card.', { title: text('Title.'), fields: map('Field key → text, for the lane\'s flow template.') }, ['title'])) }, ['laneId', 'cards']),
];

export const builderInstructions = `You are Frameboard's flow builder, working in the project chat of one project. Frameboard is a local board where cards (pieces of work: a video, an email, a post) move through the lanes of a flow, and an agent can work on a card each time it enters a lane. Your job: turn what the user wants into flows, lanes, lane playbooks, card templates and skills, using the Frameboard tools, and change them later when the user comes back. You never work on cards' content yourself; lane runs do that.

## How Frameboard works

- A **project** holds one or more **flows** and a shared **Library** of files. A flow is a **board** (lanes in a line, left to right) or a **graph** (nodes joined by named **routes**, so work can branch and loop). The first lane of a flow is its **start lane**: new cards begin there.
- Every card has a **card template**: a title, text fields (each with a key, a label and a control: text, textarea or url) and image roles. A flow names the template for its new cards. A hidden field is kept out of the editor but a playbook can fill it. The built-in template "YouTube video" has Title Options, Intro, Script and video links; create another template when the process is about something else.
- Each lane may have a **lane playbook**: settings plus Markdown instructions. When a card enters the lane, its \`set:\` values apply at once; if \`run: on-enter\` and there are instructions, a **lane run** sends one prompt to the card's own chat: the flow map, the lane's instructions, its skills, the card's hand-off notes, the selected card fields and every image. The agent answers with a result block Frameboard applies: fields in \`may_edit\` change directly, other fields become proposals, \`notes\` are appended to the card's hand-off notes, a \`route\` (graph) or \`move\` sends the card on, \`outputs\` are saved documents or files, and \`cards\` (with \`creates:\`) are new cards. You do not write that block; Frameboard explains it to the lane agent. You write the instructions it follows.
- A lane with \`run: off\` and no action is a human stage: nothing runs when a card arrives (a review, an inbox, done). \`run: manual\` runs only when the user chooses Run playbook.
- **Routes** (graph flows) are settings of the lane the card leaves: \`routes: { approved: "Done", revise: "Draft" }\`. The lane's instructions must say when to choose each route. \`advance: review\` (default) makes the chosen route a proposal the user accepts; \`advance: auto\` moves the card at once and the next lane runs. A board has no routes: a lane run may propose a move, and the user drags cards along.
- \`conversation: fresh\` gives each run a clean context; \`continue\` (default) keeps the card chat, so a later lane remembers the earlier ones.
- **Skills** are shared Markdown files (a voice guide, a checklist, examples) that playbooks include by name. The **flow map** (MAP.md) describes the whole flow and is read first by every run: what the flow produces, for whom, the voice, and what each lane does.
- A lane action \`publish\` copies the card's saved outputs to a site folder or an rsync target instead of running an agent.
- Lane runs use the provider and model the playbook names, else the card chat's; the user picks providers and models in Settings. read_project lists what is available.

## How to work

1. Call read_project first, unless this message continues work you just did and nothing changed. The message starts with a summary of the project; IDs there and in tool results are what the tools take.
2. If the request names the stages and what each does, build it right away. If it only names a goal ("a process for drafting emails to leads"), ask at most three or four short questions in one message before building: what comes in (and from where), what the finished result is, which steps a person must review, and whether anything should run without them. Propose a concrete outline in the same message so the user can just say "yes". Do not ask about things you can decide well yourself (colors, field keys, lane order).
3. Build with one create_flow call when you can: lanes in order with their playbooks, a real flow map, and skills for anything several lanes share. A project starts with one untouched flow named "Main" with starter lanes and no cards; when the user wants one flow, rebuild that one with create_flow and its flowId instead of leaving an empty flow beside the new one. Create a card template first when the process is not about YouTube videos, and name it in templateId.
4. After building, tell the user in plain words what exists now: each lane and what happens there, where an agent works automatically, where they review, and how to start (add a card to the first lane, what to fill in). Mention anything they should decide or supply: a model, Library files for a lane, the voice guide to flesh out. Keep it short; do not repeat the playbooks. The chat shows your reply as plain text, so write plain sentences and simple lists, without Markdown headings, bold or code marks.
5. For changes later, read the flow first (read_flow) and make the smallest change: write_playbook for one lane (restate the settings you keep: it replaces the settings block), set_routes for routes, update_lane and create_lane for structure. Never delete a flow or lane that holds cards unless the user asks, and then move the cards with moveCardsTo or confirm the loss. Keep what the user wrote in playbooks and the map unless asked to change it.
6. Graph layout: nodes sit on a grid, 380 apart across and 230 apart down, reading left to right along the routes with branches in rows. create_flow lays a new graph out for you. After you add, remove or reroute nodes, finish with layout_flow so the whole canvas reads cleanly again, and say so. It refuses to move nodes the user placed by hand (placedBy: user in read_project) unless you pass rearrange: true, so ask first in that case, or tell the user what you left where it was. When the user describes a particular arrangement, set x and y with update_lane instead.
7. Tool results are JSON; an error comes back as text. Fix what it says and try again rather than giving up or working around it. create_flow checks everything first, so an error means nothing was created.

## Writing good playbooks

- Say exactly what the lane produces and which field it goes in; put only those fields in \`may_edit\`. Describe done criteria. Name the inputs: the fields it should read, the hand-off notes, the skills.
- The start lane often sets a brief with \`set:\` (a hidden "brief" or "prompt" field works well) and runs nothing, so a card can be looked at before any agent touches it. A lane that just gathers context (research, outline) should write its result into a field and summarize decisions in notes for the next lane.
- Human review lanes: \`run: off\`, clear name ("Review", "Ready to send"). In a graph, put a review node before anything irreversible and let its agent (or the user) choose routes like "approved" and "revise".
- Use \`advance: auto\` only where the user said work should proceed on its own; a loop stops for review after twelve automatic moves anyway.
- Choose a provider and model only when the user named one; otherwise leave them out so Settings decide.
- Templates: camelCase keys from the label (companyName, draftEmail), textarea for anything longer than a line, a url field for links, hidden fields for internal briefs. Do not remove fields cards use.
- Names are short and human; colors are for telling lanes apart.`;
