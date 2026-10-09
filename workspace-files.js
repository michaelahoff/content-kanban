// Opens one finished file an agent or the user explicitly names in a card
// workspace, for saving as an output. Never scans or discovers files. The name
// is a workspace-relative path with no links anywhere along it; reference
// copies are inputs. Bytes stream from the opened descriptor, never reopened
// by path, and a file that changes while it is read fails rather than saving
// torn or substituted bytes.
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { imageFormat } from './image-files.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function workspacePath(relative) {
  if (typeof relative !== 'string' || !relative.length || relative.length > 4000 || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) fail(400, 'Name a file by its path inside the card workspace, without .. or a leading /.');
  if (relative.split('/')[0] === 'references') fail(400, `${relative} is a reference copy of a supplied input, not an output.`);
  return relative;
}

// `expected` ({ hash, size }) binds a retry to the bytes first verified: a
// later occupant of the path fails instead of being saved.
export async function openWorkspaceFile(root, relative, { expected = null } = {}) {
  workspacePath(relative);
  const missing = () => fail(404, `${relative} does not exist in the card workspace.`);
  if (await realpath(root).catch(missing) !== root) fail(403, 'The card workspace is a link. Nothing was saved.');
  let parent = root;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    const info = await lstat(parent).catch(missing);
    if (info.isSymbolicLink()) fail(403, `${relative} goes through a link, so it cannot be saved.`);
    if (!info.isDirectory()) missing();
  }
  const filename = path.join(root, relative);
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ELOOP') fail(403, `${relative} is a link, so it cannot be saved.`);
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) missing();
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) fail(400, `${relative} is not a regular file.`);
    if (before.nlink !== 1) fail(403, `${relative} has other hard links, so it cannot be saved.`);
    // A directory swapped for a link around the open cannot redirect it: the
    // opened descriptor must be the file now at that path, under unlinked parents.
    const now = await lstat(filename).catch(() => null);
    if (await realpath(parent) !== parent || !now || now.dev !== before.dev || now.ino !== before.ino) fail(403, `${relative} changed while it was being opened.`);
    const changed = `${relative} has changed since it was first saved, so its original bytes are gone. Nothing was saved. Save the current file as a new output.`;
    if (expected && before.size !== expected.size) fail(409, changed);
    const head = Buffer.alloc(Math.min(32, before.size));
    await handle.read(head, 0, head.length, 0);
    // Read lazily, only as retained storage consumes the bytes.
    async function* bytes() {
      const hash = createHash('sha256'); let position = 0;
      for (;;) {
        const chunk = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (!bytesRead) break;
        position += bytesRead; hash.update(chunk.subarray(0, bytesRead));
        yield chunk.subarray(0, bytesRead);
      }
      const after = await handle.stat();
      if (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.size !== before.size || position !== before.size) fail(409, `${relative} changed while it was being saved. Nothing was saved.`);
      if (expected && hash.digest('hex') !== expected.hash) fail(409, changed);
    }
    const stream = Readable.from(bytes(), { objectMode: false });
    stream.once('close', () => { handle.close().catch(() => {}); });
    return { path: relative, size: before.size, format: imageFormat(head), stream };
  } catch (error) { await handle.close(); throw error; }
}
