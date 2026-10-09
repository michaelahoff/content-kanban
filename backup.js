// Complete workspace export and restore. Every payload is streamed through
// SHA-256 with a fixed buffer, so file size never determines memory use.
import { mkdir, readdir, rename, rm, lstat, realpath, open, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { imageFormat, maxImageBytes } from './image-files.js';
import { imageIdPattern, snapshotDatabase, inspectBackupDatabase } from './store.js';

const fail = (message) => { throw new Error(message); };
const optional = async (filename) => lstat(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
const bufferSize = 64 * 1024;
const appStores = ['images', 'workspaces', 'flows', 'retained'];
// Temporary publication bytes are reclaimed by the app; they are never retained content.
const temporary = new Set(['retained/staging']);
const legacyBoard = 'board.json.migrated';
const coverage = {
  included: ['SQLite database: projects (active and archived), lanes, cards, saved states, activity, chats, submissions, attempts, cancellations, proposals, lane runs, selections and settings',
    'Image versions (data/images)', 'Every committed retained version, including superseded and removed ones (data/retained/versions)',
    'Card workspaces and hand-off notes (data/workspaces)', 'Project maps, lane playbooks and skills (data/flows)',
    'Already collected native Codex rollouts and generated images bound to card chats'],
  excluded: ['Global native credentials and configuration', 'Native conversations not bound to a card chat', 'The native Codex index',
    'External service data', 'Unsaved editor text', 'Temporary retained publication staging',
    'Image outputs that were never saved; their native file is included only when collected from a bound conversation'],
};

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Opens one regular, singly linked file below root without following any link.
async function openRegular(root, relative) {
  const filename = path.join(root, relative);
  if (await realpath(path.dirname(filename)) !== path.dirname(filename)) fail(`Linked directory refused: ${relative}`);
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ELOOP') fail(`Links and special files cannot be backed up: ${relative}`); throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) fail(`Not a regular, singly linked file: ${relative}`);
    return { handle, info };
  } catch (error) { await handle.close(); throw error; }
}
const identity = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;

// Reads the whole file once, hashing it and optionally writing the same bytes.
async function stream(handle, { target, signal } = {}) {
  const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(bufferSize); let size = 0; let head = Buffer.alloc(0);
  for (;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
    if (!bytesRead) break;
    const chunk = buffer.subarray(0, bytesRead);
    if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
    hash.update(chunk);
    for (let offset = 0; target && offset < bytesRead;) {
      const { bytesWritten } = await target.write(chunk, offset, bytesRead - offset);
      if (!bytesWritten) fail('Writing the backup made no progress.');
      offset += bytesWritten;
    }
    size += bytesRead;
  }
  return { size, sha256: hash.digest('hex'), head };
}

async function hashFile(root, relative, options) {
  const { handle } = await openRegular(root, relative);
  try { return await stream(handle, options); } finally { await handle.close(); }
}

// Copies one file into staging. `expected` is the identity recorded by the
// scan; any change before or during the copy fails rather than mixing states.
async function copyInto(sourceRoot, relative, staging, destination, { signal, expected } = {}) {
  const { handle, info } = await openRegular(sourceRoot, relative);
  try {
    if (expected && identity(info) !== expected) fail(`Changed during export: ${relative}`);
    const filename = path.join(staging, destination);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const target = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let result;
    try { result = await stream(handle, { target, signal }); await target.sync(); } finally { await target.close(); }
    if (identity(await handle.stat()) !== identity(info) || result.size !== info.size) fail(`File changed while being exported: ${relative}`);
    return { ...result, mode: info.mode & 0o777 };
  } finally { await handle.close(); }
}

// Every app-store file and directory, with the identity each must keep.
async function scan(dataDir) {
  const files = new Map(); const directories = [];
  async function walk(relative) {
    const info = await optional(path.join(dataDir, relative));
    if (!info) return;
    if (info.isDirectory()) {
      directories.push(relative);
      for (const name of (await readdir(path.join(dataDir, relative))).sort()) if (!temporary.has(`${relative}/${name}`)) await walk(`${relative}/${name}`);
    } else if (info.isFile() && info.nlink === 1) files.set(relative, identity(info));
    else fail(`Links and special files cannot be backed up: ${relative}`);
  }
  for (const root of [...appStores, legacyBoard]) await walk(root);
  return { files, directories };
}

function nativePath(relative, threads) {
  return threads.some((id) => new RegExp(`^(sessions|archived_sessions)/(?:[0-9]{4}/[0-9]{2}/[0-9]{2}/)?rollout-[0-9T:-]+-${id}\\.jsonl$`).test(relative)
    || (relative.startsWith(`generated_images/${id}/`) && /\.(png|jpg|jpeg|webp|gif|avif)$/i.test(relative)));
}

// The first JSONL record, read with a bounded buffer.
async function firstLine(root, relative) {
  const { handle } = await openRegular(root, relative);
  try {
    const buffer = Buffer.allocUnsafe(bufferSize); const parts = []; let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      parts.push(Buffer.from(buffer.subarray(0, end < 0 ? bytesRead : end))); size += bytesRead;
      if (end >= 0 || !bytesRead) return Buffer.concat(parts).toString('utf8');
      if (size > 64 * 1024 * 1024) fail(`Native rollout header is too large: ${relative}`);
    }
  } finally { await handle.close(); }
}

async function nativeCandidates(home, threads) {
  if (!threads.length || !await optional(home)) return { home: null, candidates: [] };
  home = await realpath(home);
  const candidates = [];
  // Walk directories only; unrelated native files are never opened or copied.
  async function walk(relative) {
    const info = await optional(path.join(home, relative)); if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`Linked native directory refused: ${relative}`);
    for (const name of (await readdir(path.join(home, relative))).sort()) {
      const child = `${relative}/${name}`; const entry = await lstat(path.join(home, child));
      if (entry.isDirectory()) await walk(child);
      else if (nativePath(child, threads)) candidates.push(child);
    }
  }
  for (const root of ['sessions', 'archived_sessions']) await walk(root);
  for (const id of threads) await walk(`generated_images/${id}`);
  return { home, candidates };
}

// A staging folder is owned through an OS lock on its sibling `.owner` file,
// held for the whole export and released by the kernel if the process dies.
function ownerLock(filename) {
  const db = new DatabaseSync(filename);
  try { db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;'); return db; }
  catch (error) { db.close(); if (error.errcode === 5 || /locked/.test(error.message)) return null; throw error; }
}

// Removes only staging whose owner lock is free: its export ended abnormally.
async function reclaimStaging(output) {
  for (const name of await readdir(output)) {
    const match = name.match(/^(\.incomplete-[\w.-]+?)(\.owner)?$/);
    if (!match) continue;
    const owner = ownerLock(path.join(output, `${match[1]}.owner`));
    if (!owner) continue;
    try {
      const info = await optional(path.join(output, match[1]));
      if (info?.isDirectory()) await rm(path.join(output, match[1]), { recursive: true, force: true });
      else if (info) await rm(path.join(output, match[1]), { force: true });
    } finally { owner.close(); await rm(path.join(output, `${match[1]}.owner`), { force: true }); }
  }
}

const diskFull = (error) => error?.code === 'ENOSPC' || error?.code === 'EDQUOT'
  ? Object.assign(new Error(`Not enough disk space for the backup. Nothing was published and earlier backups are unchanged. Free space at the backup location and try again. (${error.message})`), { code: error.code, cause: error })
  : error;

// `checkpoint(boundary)` is a fault-injection boundary for interruption tests.
export async function createBackup({ dataDir, output, codexHome, signal, checkpoint = async () => {} }) {
  dataDir = await realpath(dataDir);
  output = path.resolve(output);
  if (output === dataDir || output.startsWith(dataDir + path.sep)) fail('Choose a backup location outside the app data directory.');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  output = await realpath(output);
  if (output === dataDir || output.startsWith(dataDir + path.sep)) fail('Choose a backup location outside the app data directory.');
  await reclaimStaging(output);
  const name = `${createdAt.replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const staging = path.join(output, `.incomplete-${name}`); const ownerFile = `${staging}.owner`;
  const owner = ownerLock(ownerFile) ?? fail('Another export is using this staging name. Try again.');
  try {
    await mkdir(staging, { mode: 0o700 });
    const before = await scan(dataDir);
    await checkpoint('scanned');
    snapshotDatabase(path.join(dataDir, 'frameboard.db'), path.join(staging, 'frameboard.db'));
    await chmod(path.join(staging, 'frameboard.db'), 0o600);
    const { schemaVersion, images, nativeThreads: threads, retained, projects, tables, outputs } = inspectBackupDatabase(path.join(staging, 'frameboard.db'));
    // Database references are required coverage, not just files that were found.
    for (const image of images) if (!before.files.has(`images/${image.id}`)) fail(`Missing image: ${image.id}`);
    for (const version of retained) if (!before.files.has(version.path)) fail(`Missing retained version: ${version.versionId}. Repair it with its exact original bytes before exporting.`);
    const entries = [];
    const database = await hashFile(staging, 'frameboard.db', { signal });
    entries.push({ path: 'frameboard.db', size: database.size, sha256: database.sha256, mode: 0o600 });
    for (const directory of before.directories) await mkdir(path.join(staging, directory), { recursive: true, mode: 0o700 });
    for (const [relative, expected] of before.files) {
      await checkpoint('copying', relative);
      const copied = await copyInto(dataDir, relative, staging, relative, { signal, expected });
      if (relative.startsWith('images/')) {
        if (!imageIdPattern.test(path.basename(relative)) || copied.size > maxImageBytes || !imageFormat(copied.head)) fail(`Invalid stored image: ${relative}`);
        const recorded = images.find((image) => image.id === path.basename(relative))?.hash;
        if (recorded && recorded !== copied.sha256) fail(`Damaged image: ${relative}`);
      }
      const version = retained.find((item) => item.path === relative);
      if (version && (version.sha256 !== copied.sha256 || version.size !== copied.size)) fail(`Damaged retained version: ${version.versionId}. Its bytes differ from the recorded hash and size; repair it with its exact original bytes before exporting.`);
      entries.push({ path: relative, size: copied.size, sha256: copied.sha256, mode: copied.mode });
    }
    const native = await nativeCandidates(codexHome, threads);
    for (const relative of native.candidates) {
      const destination = `native/codex/${relative}`;
      const copied = await copyInto(native.home, relative, staging, destination, { signal });
      if (relative.endsWith('.jsonl')) {
        let first; try { first = JSON.parse(await firstLine(staging, destination)); } catch { first = null; }
        if (first?.type !== 'session_meta' || !threads.includes(first.payload?.id) || !relative.endsWith(`-${first.payload.id}.jsonl`)) fail(`Native rollout identity mismatch: ${relative}`);
      } else if (copied.size > maxImageBytes || !imageFormat(copied.head)) fail(`Invalid native image: ${relative}`);
      entries.push({ path: destination, size: copied.size, sha256: copied.sha256, mode: 0o600 });
    }
    // Verify the staged copies themselves before anything is published.
    await checkpoint('verifying');
    for (const entry of entries) {
      const staged = await hashFile(staging, entry.path, { signal });
      if (staged.size !== entry.size || staged.sha256 !== entry.sha256) fail(`Backup verification failed: ${entry.path}`);
    }
    const after = await scan(dataDir);
    const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].filter((relative) => before.files.get(relative) !== after.files.get(relative));
    if (changed.length || before.directories.join('\n') !== after.directories.join('\n')) fail(`App data changed during export${changed.length ? `: ${changed.slice(0, 5).join(', ')}` : ''}. Close programs editing playbooks or card workspaces and try again.`);
    let appRevision = null;
    try { appRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('.', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* A distributed copy may lack Git metadata. */ }
    // An unsaved output is not retained content; record whether its native file was collected.
    const collected = (savedPath) => {
      if (!savedPath || !native.home) return null;
      const relative = [path.resolve(codexHome), native.home].map((home) => path.relative(home, path.resolve(savedPath))).find((value) => native.candidates.includes(value));
      return relative ? `native/codex/${relative}` : null;
    };
    const outputInventory = outputs.map(({ outputId, cardId, attemptId, importStatus, imageId, savedPath }) => importStatus === 'imported'
      ? { outputId, cardId, attemptId, importStatus, retained: true, path: `images/${imageId}`, nativePath: null }
      : { outputId, cardId, attemptId, importStatus, retained: false, path: null, nativePath: collected(savedPath) });
    const nativeMissing = threads.filter((id) => !native.candidates.some((relative) => relative.endsWith(`-${id}.jsonl`)));
    const manifest = { format: 'frameboard-backup', version: 2, createdAt, appRevision, schemaVersion, coverage,
      nativeResume: 'not verified', label: 'History-only backup; native resume not verified.',
      nativeResumeReason: 'Native index dependencies are not copied; restored exact resume has not been proved.',
      nativeMissing, inventory: { projects, tables, images: images.map((image) => ({ ...image, path: `images/${image.id}` })), retained, outputs: outputInventory }, directories: before.directories, files: entries };
    const manifestFile = await open(path.join(staging, 'manifest.json'), 'wx', 0o600);
    try { await manifestFile.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await manifestFile.sync(); } finally { await manifestFile.close(); }
    await syncDirectory(staging);
    await checkpoint('publishing');
    signal?.throwIfAborted();
    const backupDir = path.join(output, `frameboard-${name}`);
    await rename(staging, backupDir);
    await syncDirectory(output);
    return { backupDir, nativeResume: manifest.nativeResume, label: manifest.label };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw diskFull(error);
  } finally { owner.close(); await rm(ownerFile, { force: true }); }
}

function validPath(relative) {
  return typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !relative.includes('\0')
    && !path.posix.isAbsolute(relative) && relative.split('/').every((part) => part && part !== '.' && part !== '..');
}

async function readManifest(root) {
  const { handle, info } = await openRegular(root, 'manifest.json');
  try { if (info.size > 256 * 1024 * 1024) fail('The backup manifest is too large.'); return (await handle.readFile()).toString('utf8'); }
  finally { await handle.close(); }
}

async function verifyBackupFile(root, entry) {
  const { size, sha256 } = await hashFile(root, entry.path);
  if (size !== entry.size || sha256 !== entry.sha256) fail(`Backup hash mismatch: ${entry.path}`);
}

export async function restoreBackup({ backupDir, dataDir, codexHome }) {
  backupDir = await realpath(backupDir); dataDir = path.resolve(dataDir);
  let manifest;
  try { manifest = JSON.parse(await readManifest(backupDir)); } catch { fail('Unsupported backup manifest.'); }
  if (manifest.format !== 'frameboard-backup' || ![1, 2].includes(manifest.version) || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) fail('Unsupported backup manifest.');
  const roots = manifest.version === 1 ? ['images', 'workspaces', 'flows'] : appStores;
  const appPath = (relative) => relative === 'frameboard.db' || (manifest.version === 2 && relative === legacyBoard)
    || roots.some((root) => relative === root || relative.startsWith(`${root}/`));
  const allowed = (relative) => validPath(relative) && (appPath(relative) || relative.startsWith('native/codex/'));
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!allowed(entry.path) || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail('Invalid backup file entry.');
    seen.add(entry.path);
    await verifyBackupFile(backupDir, entry);
  }
  if (!seen.has('frameboard.db')) fail('The backup database is missing.');
  for (const directory of manifest.directories) if (!validPath(directory) || !appPath(directory) || seen.has(directory) || directory === 'frameboard.db') fail('Invalid backup directory entry.');
  const { images, nativeThreads: threads, retained } = inspectBackupDatabase(path.join(backupDir, 'frameboard.db'));
  for (const image of images) {
    const entry = manifest.files.find((item) => item.path === `images/${image.id}`);
    if (!entry) fail(`Missing image: ${image.id}`);
    if (image.hash && image.hash !== entry.sha256) fail(`Damaged image: ${image.id}`);
  }
  for (const version of retained) {
    const entry = manifest.files.find((item) => item.path === version.path);
    if (!entry) fail(`Missing retained version: ${version.versionId}`);
    if (entry.sha256 !== version.sha256 || entry.size !== version.size) fail(`Damaged retained version: ${version.versionId}`);
  }
  for (const entry of manifest.files) if (entry.path.startsWith('native/') && !nativePath(entry.path.slice(13), threads)) fail('Only bound native conversation files may be restored.');
  const existing = await optional(dataDir);
  if (existing && (!existing.isDirectory() || (await readdir(dataDir)).length)) fail('Restore needs a new or empty app data directory. Existing app data will not be overwritten.');
  await mkdir(path.dirname(dataDir), { recursive: true, mode: 0o700 });
  const staging = path.join(path.dirname(dataDir), `.frameboard-restore-${Date.now()}-${process.pid}`);
  await mkdir(staging, { mode: 0o700 });
  const nativeCopied = []; const nativeSkipped = [];
  try {
    for (const directory of manifest.directories) await mkdir(path.join(staging, directory), { recursive: true, mode: 0o700 });
    for (const entry of manifest.files) {
      if (entry.path.startsWith('native/')) continue;
      const copied = await copyInto(backupDir, entry.path, staging, entry.path);
      if (copied.size !== entry.size || copied.sha256 !== entry.sha256) fail(`Backup hash mismatch: ${entry.path}`);
      await chmod(path.join(staging, entry.path), entry.mode);
    }
    // Do not merge the global native index or any global configuration. Native
    // files use exclusive creation even when the destination already exists.
    for (const entry of manifest.files.filter((item) => item.path.startsWith('native/'))) {
      const relative = entry.path.slice(13);
      const root = path.resolve(codexHome);
      await mkdir(root, { recursive: true, mode: 0o700 });
      if (await realpath(root) !== root) fail('Native restore home cannot be a symbolic link.');
      let parent = root;
      for (const part of relative.split('/').slice(0, -1)) {
        parent = path.join(parent, part);
        await mkdir(parent, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
        if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) fail(`Linked native restore directory refused: ${relative}`);
      }
      try {
        const copied = await copyInto(backupDir, entry.path, root, relative);
        if (copied.size !== entry.size || copied.sha256 !== entry.sha256) { await rm(path.join(root, relative), { force: true }); fail(`Backup hash mismatch: ${entry.path}`); }
        nativeCopied.push(relative);
      } catch (error) { if (error.code !== 'EEXIST') throw error; nativeSkipped.push(relative); }
    }
    await rename(staging, dataDir);
    return { dataDir, nativeResume: 'not verified', label: 'History-only backup; native resume not verified.', nativeCopied, nativeSkipped };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
