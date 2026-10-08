// The only module that touches playbook files. Each flow keeps its documents in
// data/flows/<flowId>/: MAP.md, lanes/*.md (one per lane, identified by the
// `lane:` setting rather than the file name) and skills/*.md. Card hand-off
// notes live in each card workspace as notes.md.
//
// Rules that keep a later move to database storage cheap (ADR 0003): nothing
// else reads these folders, lanes are found by ID, every write checks the hash
// it was based on, and documents refer to each other by relative path.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { parseDocument, playbookSettings, mapTemplate, serializeDocument, maxDocumentLength, skillName } from './public/playbook-format.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const documentHash = (text) => createHash('sha256').update(text).digest('hex');
const idPattern = /^[\w-]{1,100}$/;
const fileName = /^[a-z0-9][a-z0-9_-]{0,79}\.md$/i;

export function slug(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'lane';
}

export function createPlaybooks({ dataDir }) {
  const flowRoot = (flowId) => {
    if (!idPattern.test(flowId)) fail(400, 'Invalid flow.');
    return path.join(dataDir, 'flows', flowId);
  };
  // Only MAP.md, lanes/<name>.md and skills/<name>.md are documents.
  function resolve(flowId, relative) {
    if (typeof relative !== 'string') fail(400, 'Choose a playbook document.');
    const parts = relative.split('/');
    const valid = (parts.length === 1 && parts[0] === 'MAP.md') || (parts.length === 2 && ['lanes', 'skills'].includes(parts[0]) && fileName.test(parts[1]));
    if (!valid) fail(400, 'Playbook documents are MAP.md, lanes/<name>.md or skills/<name>.md.');
    return path.join(flowRoot(flowId), ...parts);
  }
  function readText(filename) {
    try {
      if (!lstatSync(filename).isFile()) return null;
      return readFileSync(filename, 'utf8');
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  }
  // Atomic replacement: a crash leaves the old or the new file, never half.
  function writeText(filename, text) {
    mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { flag: 'wx' });
    try { renameSync(temporary, filename); } catch (error) { try { unlinkSync(temporary); } catch { /* Already gone. */ } throw error; }
  }
  const documentFrom = (relative, text) => (text === null ? null : { path: relative, text, hash: documentHash(text) });
  const listDir = (flowId, folder) => {
    try { return readdirSync(path.join(flowRoot(flowId), folder)).filter((name) => fileName.test(name)).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  function laneDocuments(flowId) {
    return listDir(flowId, 'lanes').map((name) => {
      const relative = `lanes/${name}`;
      const document = documentFrom(relative, readText(resolve(flowId, relative)));
      return document && { ...document, laneId: parseDocument(document.text).data.lane ?? null };
    }).filter(Boolean);
  }

  const api = {
    root: flowRoot,
    // Creates the folder with a starter map the first time a flow is used.
    ensure(flowId, { projectName, lanes }) {
      const filename = resolve(flowId, 'MAP.md');
      if (!existsSync(filename)) writeText(filename, mapTemplate(projectName, lanes));
      for (const folder of ['lanes', 'skills']) mkdirSync(path.join(flowRoot(flowId), folder), { recursive: true });
    },
    read(flowId, relative) { return documentFrom(relative, readText(resolve(flowId, relative))); },
    lanes: laneDocuments,
    list(flowId) {
      return {
        folder: flowRoot(flowId),
        map: api.read(flowId, 'MAP.md'),
        lanes: laneDocuments(flowId),
        skills: listDir(flowId, 'skills').map((name) => api.read(flowId, `skills/${name}`)).filter(Boolean),
      };
    },
    // The playbook for a lane is the lanes/ file whose settings name it. When
    // two files claim one lane, the first by name wins and the other is shown
    // as a conflict in the editor.
    forStage(flowId, stageId) {
      return laneDocuments(flowId).find((document) => document.laneId === stageId) ?? null;
    },
    settings(flowId, stageId, templateId) {
      const document = api.forStage(flowId, stageId);
      return document ? { document, settings: playbookSettings(parseDocument(document.text), templateId) } : null;
    },
    // Compare-and-swap: baseHash is the hash the editor loaded, or null to
    // create a document that must not exist yet.
    write(flowId, relative, text, baseHash, { laneIds = null } = {}) {
      if (typeof text !== 'string' || text.length > maxDocumentLength) fail(400, `Playbook documents can be up to ${maxDocumentLength.toLocaleString('en-US')} characters.`);
      if (baseHash !== null && (typeof baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(baseHash))) fail(400, 'Saving needs the version you edited.');
      const filename = resolve(flowId, relative);
      const current = readText(filename);
      if (baseHash === null ? current !== null : current === null || documentHash(current) !== baseHash) {
        fail(409, current === null ? 'This document was deleted on disk. Copy your text, then reload.' : 'This document changed on disk since you opened it. Copy your text, then reload to see the newer version.');
      }
      if (relative.startsWith('lanes/')) {
        const laneId = parseDocument(text).data.lane;
        if (laneIds && laneId && !laneIds.includes(laneId)) fail(400, 'The lane setting must be the ID of a lane in this project.');
        const claimed = laneId && laneDocuments(flowId).find((document) => document.laneId === laneId && document.path !== relative);
        if (claimed) fail(409, `${claimed.path} is already this lane's playbook.`);
      }
      writeText(filename, text);
      return api.read(flowId, relative);
    },
    remove(flowId, relative, baseHash) {
      const filename = resolve(flowId, relative);
      if (relative === 'MAP.md') fail(400, 'The project map cannot be deleted. Clear its text instead.');
      const current = readText(filename);
      if (current === null) return;
      if (documentHash(current) !== baseHash) fail(409, 'This document changed on disk since you opened it. Reload before deleting.');
      unlinkSync(filename);
    },
    // A new lanes/ file name derived from the lane name, never overwriting.
    freePath(flowId, name) {
      const base = slug(name);
      for (let index = 1; ; index++) {
        const relative = `lanes/${index === 1 ? base : `${base}-${index}`}.md`;
        if (!existsSync(resolve(flowId, relative))) return relative;
      }
    },
    skill(flowId, name) {
      if (!skillName.test(name)) return { name, path: `skills/${name}.md`, text: null };
      const document = api.read(flowId, `skills/${name}.md`);
      return { name, path: `skills/${name}.md`, text: document?.text ?? null, hash: document?.hash ?? null };
    },
    // One-time move of a lane's Set field commands into its playbook.
    migrateSet(flowId, stage, set) {
      if (api.forStage(flowId, stage.id)) return false;
      const relative = api.freePath(flowId, stage.name);
      writeText(resolve(flowId, relative), serializeDocument({ lane: stage.id, run: 'off', set },
        `# ${stage.name}\n\nThis playbook was created from the lane's Set field commands. Those values still apply when a card enters the lane.\n\nWrite instructions here and change \`run\` to \`on-enter\` to have an agent work on each card that arrives.\n`));
      return true;
    },

    notesPath: (cardId) => {
      if (!idPattern.test(cardId)) fail(400, 'Invalid card.');
      return path.join(dataDir, 'workspaces', cardId, 'notes.md');
    },
    notes(cardId) {
      const text = readText(api.notesPath(cardId)) ?? '';
      return { text, hash: documentHash(text) };
    },
    writeNotes(cardId, text, baseHash) {
      if (typeof text !== 'string' || text.length > maxDocumentLength) fail(400, `Notes can be up to ${maxDocumentLength.toLocaleString('en-US')} characters.`);
      if (api.notes(cardId).hash !== baseHash) fail(409, 'These notes changed since you opened them. Copy your text, then reload.');
      writeText(api.notesPath(cardId), text);
      return api.notes(cardId);
    },
    appendNotes(cardId, heading, text) {
      const current = api.notes(cardId).text;
      const entry = `## ${heading}\n\n${text.trim()}\n`;
      let combined = current.trim() ? `${current.trimEnd()}\n\n${entry}` : entry;
      if (combined.length > maxDocumentLength) {
        const marker = '…(earlier hand-off notes omitted)\n\n';
        combined = marker + combined.slice(-(maxDocumentLength - marker.length));
      }
      writeText(api.notesPath(cardId), combined);
      return api.notes(cardId);
    },
  };
  return api;
}
