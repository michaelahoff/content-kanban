// Complete workspace export and restore. Every payload is streamed through
// SHA-256 with a fixed buffer, so file size never determines memory use.
import { mkdir, readdir, rename, rm, lstat, realpath, open, chmod, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { imageFormat, maxImageBytes } from './image-files.js';
import { imageIdPattern, snapshotDatabase, inspectBackupDatabase, markRestored, supportedSchemaVersion } from './store.js';
import { holdExclusiveLock } from './data-lock.js';

const fail = (message) => { throw new Error(message); };
const optional = async (filename) => lstat(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
const bufferSize = 64 * 1024;
const appStores = ['images', 'workspaces', 'flows', 'retained'];
// Backup reads every app store directly while it owns the data directory (the
// lock or maintenance); it never writes there. Temporary publication bytes are
// reclaimed by the app and are never retained content.
const temporaryStores = new Set(['retained/staging']);
const legacyBoard = 'board.json.migrated';
const coverage = {
  included: ['SQLite database: projects (active and archived), lanes, cards, saved states, activity, chats, submissions, attempts, cancellations, proposals, lane runs, selections and settings',
    'Image versions (data/images)', 'Every committed retained version, including superseded and removed ones (data/retained/versions)',
    'Card workspaces and hand-off notes (data/workspaces)', 'Project maps, lane playbooks and skills (data/flows)',
    'Already collected native Codex rollouts and generated images bound to card chats'],
  excluded: ['Global native credentials and configuration', 'Native conversations not bound to a card chat', 'The native Codex index',
    'Native Claude session files, including bound ones (their card chat history is in the database)',
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
const sameBytes = (a, b) => a.size === b.size && a.sha256 === b.sha256;
const identity = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;

// Reads the whole file once, hashing it and optionally writing the same bytes.
async function hashCopy(handle, { target, signal } = {}) {
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
  try { return await hashCopy(handle, options); } finally { await handle.close(); }
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
    try {
      let result;
      try { result = await hashCopy(handle, { target, signal }); await target.sync(); } finally { await target.close(); }
      if (identity(await handle.stat()) !== identity(info) || result.size !== info.size) fail(`File changed while being exported: ${relative}`);
      return { ...result, mode: info.mode & 0o777 };
    } catch (error) { await rm(filename, { force: true }); throw error; } // Only the file this call created.
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
      for (const name of (await readdir(path.join(dataDir, relative))).sort()) if (!temporaryStores.has(`${relative}/${name}`)) await walk(`${relative}/${name}`);
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

// Each staging folder has a sibling `.owner` file, created exclusively before
// the folder and locked for the whole export; the kernel releases the lock if
// the process dies. Only staging with that proof of ownership is reclaimed.
const stagingName = /^\.incomplete-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}$/;
async function claimStaging(output, name) {
  const staging = path.join(output, `.incomplete-${name}`); const ownerFile = `${staging}.owner`;
  await (await open(ownerFile, 'wx', 0o600)).close();
  const owner = holdExclusiveLock(ownerFile);
  if (!owner) { await rm(ownerFile, { force: true }); fail('Another export or restore claimed this staging folder. Try again.'); }
  try { await mkdir(staging, { mode: 0o700 }); }
  catch (error) { owner.close(); await rm(ownerFile, { force: true }); throw error; }
  return { staging, release: async () => { owner.close(); await rm(ownerFile, { force: true }); } };
}

async function reclaimAbandonedStaging(output) {
  const names = new Set(await readdir(output));
  for (const name of names) {
    const owned = name.endsWith('.owner') ? name.slice(0, -6) : null;
    if (!stagingName.test(owned ?? name) || (!owned && !names.has(`${name}.owner`))) continue;
    const ownerFile = path.join(output, `${owned ?? name}.owner`);
    // Another export sharing this folder may publish or clean up meanwhile.
    const ownerInfo = await optional(ownerFile);
    // A lone owner file may belong to an export between its two creation steps.
    if (!ownerInfo || (owned && (names.has(owned) || Date.now() - ownerInfo.mtimeMs < 60 * 60 * 1000))) continue;
    // An unreadable owner file is not proof of ownership; leave it alone.
    let owner; try { owner = holdExclusiveLock(ownerFile); } catch { owner = null; }
    if (!owner) continue;
    try { if (!owned && (await optional(path.join(output, name)))?.isDirectory()) await rm(path.join(output, name), { recursive: true, force: true }); }
    finally { owner.close(); await rm(ownerFile, { force: true }); }
  }
}

const exportDiskFull = 'Not enough disk space for the backup. Nothing was published and earlier backups are unchanged. Free space at the backup location and try again.';
const explainDiskFull = (error, message) => error?.code === 'ENOSPC' || error?.code === 'EDQUOT'
  ? Object.assign(new Error(`${message} (${error.message})`), { code: error.code, cause: error })
  : error;

// `checkpoint(boundary)` is a fault-injection boundary for interruption tests.
export async function createBackup(options) {
  try { return await exportWorkspace(options); } catch (error) { throw explainDiskFull(error, exportDiskFull); }
}

async function exportWorkspace({ dataDir, output, codexHome, signal, checkpoint = async () => {} }) {
  dataDir = await realpath(dataDir);
  output = path.resolve(output);
  if (output === dataDir || output.startsWith(dataDir + path.sep)) fail('Choose a backup location outside the app data directory.');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  output = await realpath(output);
  if (output === dataDir || output.startsWith(dataDir + path.sep)) fail('Choose a backup location outside the app data directory.');
  await reclaimAbandonedStaging(output);
  const name = `${createdAt.replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const { staging, release } = await claimStaging(output, name);
  try {
    const before = await scan(dataDir);
    await checkpoint('scanned');
    snapshotDatabase(path.join(dataDir, 'frameboard.db'), path.join(staging, 'frameboard.db'));
    await chmod(path.join(staging, 'frameboard.db'), 0o600);
    const { schemaVersion, images, nativeThreads: threads, retained, projects, tables, outputs } = inspectBackupDatabase(path.join(staging, 'frameboard.db'));
    // Database references are required coverage, not just files that were found.
    for (const image of images) if (!before.files.has(`images/${image.id}`)) fail(`Missing image: ${image.id}`);
    for (const version of retained) if (!before.files.has(version.path)) fail(`Missing retained version: ${version.versionId}. Repair it with its exact original bytes before exporting.`);
    // Every retained project's map exists from its creation (startup recreates a starter otherwise).
    for (const project of projects) if (!project.deletedAt && !before.files.has(`flows/${project.flowId}/MAP.md`)) fail(`Missing project map for "${project.name}": flows/${project.flowId}/MAP.md. Restore the file, or start Frameboard once to recreate a starter map, then export again.`);
    const recordedImageHash = new Map(images.map((image) => [`images/${image.id}`, image.hash]));
    const retainedByPath = new Map(retained.map((version) => [version.path, version]));
    const entries = [];
    const database = await hashFile(staging, 'frameboard.db', { signal });
    entries.push({ path: 'frameboard.db', size: database.size, sha256: database.sha256, mode: 0o600 });
    for (const directory of before.directories) await mkdir(path.join(staging, directory), { recursive: true, mode: 0o700 });
    for (const [relative, expected] of before.files) {
      await checkpoint('copying', relative);
      const copied = await copyInto(dataDir, relative, staging, relative, { signal, expected });
      if (relative.startsWith('images/')) {
        if (!imageIdPattern.test(path.basename(relative)) || copied.size > maxImageBytes || !imageFormat(copied.head)) fail(`Invalid stored image: ${relative}`);
        const recorded = recordedImageHash.get(relative);
        if (recorded && recorded !== copied.sha256) fail(`Damaged image: ${relative}`);
      }
      const version = retainedByPath.get(relative);
      if (version && !sameBytes(version, copied)) fail(`Damaged retained version: ${version.versionId}. Its bytes differ from the recorded hash and size; repair it with its exact original bytes before exporting.`);
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
      if (!sameBytes(staged, entry)) fail(`Backup verification failed: ${entry.path}`);
    }
    const after = await scan(dataDir);
    const changed = [...new Set([...before.files.keys(), ...after.files.keys()])].filter((relative) => before.files.get(relative) !== after.files.get(relative));
    if (changed.length || before.directories.join('\n') !== after.directories.join('\n')) fail(`App data changed during export${changed.length ? `: ${changed.slice(0, 5).join(', ')}` : ''}. Something was still writing: close programs editing playbooks or card workspaces, then try again.`);
    let appRevision = null;
    try { appRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('.', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* A distributed copy may lack Git metadata. */ }
    // An unsaved output is not retained content; record whether its native file was collected.
    const collectedNativePath = (savedPath) => {
      if (!savedPath || !native.home) return null;
      const relative = [path.resolve(codexHome), native.home].map((home) => path.relative(home, path.resolve(savedPath))).find((value) => native.candidates.includes(value));
      return relative ? `native/codex/${relative}` : null;
    };
    const outputInventory = outputs.map(({ outputId, cardId, attemptId, importStatus, imageId, savedPath }) => importStatus === 'imported'
      ? { outputId, cardId, attemptId, importStatus, retained: true, path: `images/${imageId}`, nativePath: null }
      : { outputId, cardId, attemptId, importStatus, retained: false, path: null, nativePath: collectedNativePath(savedPath) });
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
    throw error;
  } finally { await release(); }
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
  if (!sameBytes(await hashFile(root, entry.path), entry)) fail(`Backup hash mismatch: ${entry.path}`);
}

// Compares the manifest's inventory with the staged database's own.
function sameInventory(recorded, { projects, tables, retained, images, outputs }) {
  const output = ({ outputId, cardId, attemptId, importStatus, path }) => ({ outputId, cardId, attemptId, importStatus, path });
  return isDeepStrictEqual(recorded?.projects, projects) && isDeepStrictEqual(recorded?.tables, tables) && isDeepStrictEqual(recorded?.retained, retained)
    && isDeepStrictEqual(recorded?.images, images.map((image) => ({ ...image, path: `images/${image.id}` })))
    && isDeepStrictEqual(recorded?.outputs?.map(output), outputs.map((value) => output({ ...value, path: value.importStatus === 'imported' ? `images/${value.imageId}` : null })));
}

const restoreDiskFull = 'Not enough disk space to restore the backup. Nothing was activated and existing data is unchanged. Free space at the restore location and try again.';

// Restores a whole workspace into a new or empty directory. Everything is
// copied into owned private staging and verified there: streamed size/hash,
// database integrity and schema, and required coverage. Only then is the
// restore marked for its startup recovery hold and activated by one rename.
// `checkpoint(boundary)` is a fault-injection boundary for interruption tests.
export async function restoreBackup(options) {
  try { return await restoreWorkspace(options); } catch (error) { throw explainDiskFull(error, restoreDiskFull); }
}

async function restoreWorkspace({ backupDir, dataDir, codexHome, checkpoint = async () => {} }) {
  backupDir = await realpath(backupDir); dataDir = path.resolve(dataDir);
  let manifest;
  try { manifest = JSON.parse(await readManifest(backupDir)); } catch { fail('Unsupported backup manifest.'); }
  if (manifest.format !== 'frameboard-backup' || ![1, 2].includes(manifest.version) || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) fail('Unsupported backup manifest.');
  const roots = manifest.version === 1 ? ['images', 'workspaces', 'flows'] : appStores;
  const appPath = (relative) => relative === 'frameboard.db' || (manifest.version === 2 && relative === legacyBoard)
    || roots.some((root) => relative === root || relative.startsWith(`${root}/`));
  const allowed = (relative) => validPath(relative) && (appPath(relative) || relative.startsWith('native/codex/'));
  const entries = new Map();
  for (const entry of manifest.files) {
    if (!allowed(entry?.path) || entries.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail('Invalid backup file entry.');
    entries.set(entry.path, entry);
  }
  if (!entries.has('frameboard.db')) fail('The backup database is missing.');
  for (const directory of manifest.directories) if (!validPath(directory) || !appPath(directory) || entries.has(directory) || directory === 'frameboard.db') fail('Invalid backup directory entry.');
  const appFiles = manifest.files.filter((entry) => !entry.path.startsWith('native/'));
  const nativeFiles = manifest.files.filter((entry) => entry.path.startsWith('native/'));

  const existing = await optional(dataDir);
  const emptyDestination = 'Restore needs a new or empty app data directory. Existing app data will not be overwritten.';
  if (existing && (!existing.isDirectory() || (await readdir(dataDir)).length)) fail(emptyDestination);
  await mkdir(path.dirname(dataDir), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(dataDir)); dataDir = path.join(parent, path.basename(dataDir));
  if (dataDir === backupDir || dataDir.startsWith(backupDir + path.sep) || backupDir.startsWith(dataDir + path.sep)) fail('Choose a restore location outside the backup folder.');
  await reclaimAbandonedStaging(parent);
  const { staging, release } = await claimStaging(parent, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  const nativeRoot = path.resolve(codexHome); const nativeCopied = []; const nativeSkipped = [];
  try {
    // One streamed read per file: the copy is hashed as it is written.
    for (const directory of manifest.directories) await mkdir(path.join(staging, directory), { recursive: true, mode: 0o700 });
    for (const entry of appFiles) {
      await checkpoint('copying', entry.path);
      if (!sameBytes(await copyInto(backupDir, entry.path, staging, entry.path), entry)) fail(`Backup hash mismatch: ${entry.path}`);
      await chmod(path.join(staging, entry.path), entry.mode);
    }
    await checkpoint('verifying');
    const database = path.join(staging, 'frameboard.db');
    let inspected;
    try { inspected = inspectBackupDatabase(database); } catch (error) { fail(`The backup database is damaged or unsupported: ${error.message}`); }
    const { schemaVersion, images, nativeThreads: threads, retained } = inspected;
    if (!(Number(schemaVersion) >= 1)) fail('The backup database is damaged or unsupported: it has no schema version.');
    if (Number(schemaVersion) > supportedSchemaVersion) fail('This backup was saved by a newer version of Frameboard. Update Frameboard, then restore it.');
    // The relationship inventory recorded at export must describe this database.
    if (manifest.version === 2 && !sameInventory(manifest.inventory, inspected)) fail('The backup inventory does not match its database. The backup was changed after export.');
    for (const image of images) {
      const entry = entries.get(`images/${image.id}`);
      if (!entry) fail(`Missing image: ${image.id}`);
      if (image.hash && image.hash !== entry.sha256) fail(`Damaged image: ${image.id}`);
    }
    for (const version of retained) {
      const entry = entries.get(version.path);
      if (!entry) fail(`Missing retained version: ${version.versionId}`);
      if (!sameBytes(entry, version)) fail(`Damaged retained version: ${version.versionId}`);
    }
    for (const entry of nativeFiles) {
      if (!nativePath(entry.path.slice(13), threads)) fail('Only bound native conversation files may be restored.');
      await verifyBackupFile(backupDir, entry);
    }
    markRestored(database, { restoredAt: new Date().toISOString(), backupCreatedAt: manifest.createdAt ?? null, backup: path.basename(backupDir) });
    for (const directory of [...manifest.directories].reverse()) await syncDirectory(path.join(staging, directory));
    await syncDirectory(staging);
    // Do not merge the global native index or any global configuration. Native
    // files use exclusive creation even when the destination already exists.
    for (const entry of nativeFiles) {
      const relative = entry.path.slice(13);
      await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
      if (await realpath(nativeRoot) !== nativeRoot) fail('Native restore home cannot be a symbolic link.');
      let directory = nativeRoot;
      for (const part of relative.split('/').slice(0, -1)) {
        directory = path.join(directory, part);
        await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
        if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) fail(`Linked native restore directory refused: ${relative}`);
      }
      // A verified temporary copy is linked into place, so a crash can leave
      // only a dot-named temporary file, never a truncated native file.
      const temporary = path.join(path.dirname(relative), `.${path.basename(relative)}.frameboard-restore-${randomUUID()}`);
      try {
        if (!sameBytes(await copyInto(backupDir, entry.path, nativeRoot, temporary), entry)) fail(`Backup hash mismatch: ${entry.path}`);
        await link(path.join(nativeRoot, temporary), path.join(nativeRoot, relative));
        nativeCopied.push(relative);
      } catch (error) { if (error.code !== 'EEXIST') throw error; nativeSkipped.push(relative); }
      finally { await rm(path.join(nativeRoot, temporary), { force: true }); }
    }
    await checkpoint('activating');
    // Renaming onto anything but a missing or still-empty directory fails, so
    // data written there meanwhile is never merged or replaced.
    try { await rename(staging, dataDir); }
    catch (error) { if (['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(error.code)) fail(emptyDestination); throw error; }
    await syncDirectory(parent);
    return { dataDir, nativeResume: 'not verified', label: 'History-only backup; native resume not verified.', nativeCopied, nativeSkipped,
      recovery: 'Unfinished work is held for review and nothing resumes. Reconnect a provider and send new work; continue old conversations in fresh context.' };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // Only native files this restore created exclusively are removed.
    for (const relative of nativeCopied) await rm(path.join(nativeRoot, relative), { force: true });
    throw error;
  } finally { await release(); }
}
