// Reads the board.json file used before storage moved to SQLite. Kept only so
// existing boards can be imported once; nothing writes this format anymore.
import { readFile } from 'node:fs/promises';

const imageIdPattern = /^[a-f0-9-]{36}\.(png|jpg|webp|gif|avif)$/;
const colors = ['lavender', 'blue', 'amber', 'green', 'pink', 'gray', 'teal', 'cyan', 'orange', 'red', 'purple', 'lime'];

function assert(value, message) {
  if (!value) throw new Error(message);
}

// Cards saved before the rename kept the original video under "muse" keys.
export function migrateBoard(board) {
  for (const card of (board?.projects || []).flatMap((project) => project?.lanes || []).flatMap((lane) => lane?.cards || [])) {
    if (!card || typeof card !== 'object') continue;
    for (const [from, to] of [['museVideoUrl', 'originalVideoUrl'], ['museVideoTitle', 'originalVideoTitle']]) {
      if (!(from in card)) continue;
      if (!card[to]) card[to] = card[from];
      delete card[from];
    }
  }
  return board;
}

export function validateBoard(board) {
  const ids = new Set();
  const string = (value, max) => typeof value === 'string' && value.length <= max;
  const entity = (item) => {
    assert(item && string(item.id, 100) && item.id.length && !ids.has(item.id), 'Invalid or duplicate ID.');
    ids.add(item.id);
  };
  assert(board && Array.isArray(board.projects) && board.projects.length <= 200, 'Invalid project list.');
  for (const project of board.projects) {
    entity(project);
    assert(string(project.name, 150) && project.name.trim(), 'Projects need a name (up to 150 characters).');
    assert(Array.isArray(project.lanes) && project.lanes.length <= 100, 'Invalid lane list.');
    for (const lane of project.lanes) {
      entity(lane);
      assert(string(lane.name, 100) && lane.name.trim() && colors.includes(lane.color), 'Invalid lane.');
      assert(Array.isArray(lane.cards) && lane.cards.length <= 10000, 'Invalid card list.');
      for (const card of lane.cards) {
        entity(card);
        assert(string(card.title, 500) && string(card.intro, 200000) && string(card.script, 1000000), 'Invalid card text.');
        assert(card.titleOptions === undefined || string(card.titleOptions, 200000), 'Invalid title options.');
        assert(card.prompt === undefined || string(card.prompt, 200000), 'Invalid card prompt.');
        assert(card.originalVideoTitle === undefined || string(card.originalVideoTitle, 500), 'Invalid original video title.');
        for (const field of ['originalVideoUrl', 'publishedVideoUrl']) {
          assert(card[field] === undefined || string(card[field], 4096), 'Video URLs must be text of up to 4096 characters.');
        }
        assert(card.updatedAt === undefined || (string(card.updatedAt, 24) && Number.isFinite(Date.parse(card.updatedAt)) && new Date(card.updatedAt).toISOString() === card.updatedAt), 'Invalid last-edited timestamp.');
        assert(Array.isArray(card.images) && card.images.length <= 200, 'Invalid card images.');
        const images = new Set();
        for (const image of card.images) {
          assert(image && imageIdPattern.test(image.id) && string(image.name, 500) && !images.has(image.id), 'Invalid image.');
          images.add(image.id);
        }
        assert(card.coverImageId === null || images.has(card.coverImageId), 'The display image must belong to the card.');
        for (const field of ['originalImageId', 'inspirationImageId']) {
          assert(card[field] === undefined || card[field] === null || images.has(card[field]), 'Flagged images must belong to the card.');
        }
      }
    }
  }
}

// Returns the saved board, or null when there is no legacy file to import.
export async function readLegacyBoard(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const state = JSON.parse(text);
  validateBoard(migrateBoard(state.board));
  if (!Number.isInteger(state.revision)) throw new Error('Invalid saved board revision.');
  return state;
}
