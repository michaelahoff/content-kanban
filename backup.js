import { mkdir, mkdtemp, readdir, writeFile, rename, rm, lstat, realpath, open, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sha256, imageFormat, maxImageBytes } from './image-files.js';
import { imageIdPattern, snapshotDatabase, inspectBackupDatabase } from './store.js';

const fail = (message) => { throw new Error(message); };
const optional = async (filename) => lstat(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });

async function regularBytes(root, relative) {
  const filename = path.join(root, relative);
  if (await realpath(path.dirname(filename)) !== path.dirname(filename)) fail(`Linked directory refused: ${relative}`);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1) fail(`Not a regular, singly linked file: ${relative}`);
    const bytes = await file.readFile();
    const after = await file.stat();
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || bytes.length !== info.size) fail(`File changed while being backed up: ${relative}`);
    return bytes;
  } finally { await file.close(); }
}

async function inventory(root, relative, files, directories) {
  const info = await optional(path.join(root, relative));
  if (!info) return;
  if (info.isDirectory()) {
    directories.push(relative);
    for (const name of (await readdir(path.join(root, relative))).sort()) await inventory(root, `${relative}/${name}`, files, directories);
  } else if (info.isFile() && info.nlink === 1) files.push(relative);
  else fail(`Links and special files cannot be backed up: ${relative}`);
}

function nativePath(relative, threads) {
  return threads.some((id) => new RegExp(`^(sessions|archived_sessions)/(?:[0-9]{4}/[0-9]{2}/[0-9]{2}/)?rollout-[0-9T:-]+-${id}\\.jsonl$`).test(relative)
    || (relative.startsWith(`generated_images/${id}/`) && /\.(png|jpg|jpeg|webp|gif|avif)$/i.test(relative)));
}

async function selectedNative(home, threads) {
  const files = []; const missing = [];
  if (!await optional(home)) return { files, missing: threads };
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
  if (threads.length) for (const root of ['sessions', 'archived_sessions']) await walk(root);
  for (const id of threads) await walk(`generated_images/${id}`);
  for (const relative of candidates) {
    const bytes = await regularBytes(home, relative);
    if (relative.endsWith('.jsonl')) {
      const first = JSON.parse(bytes.toString('utf8').split('\n', 1)[0]);
      if (first.type !== 'session_meta' || !threads.includes(first.payload?.id) || !relative.endsWith(`-${first.payload.id}.jsonl`)) fail(`Native rollout identity mismatch: ${relative}`);
    } else if (bytes.length > maxImageBytes || !imageFormat(bytes)) fail(`Invalid native image: ${relative}`);
    files.push({ relative, bytes });
  }
  for (const id of threads) if (!files.some((item) => item.relative.endsWith(`-${id}.jsonl`))) missing.push(id);
  return { files, missing };
}

export async function createBackup({ dataDir, output, codexHome }) {
  dataDir = await realpath(dataDir);
  output = path.resolve(output);
  if (output === dataDir || output.startsWith(dataDir + path.sep)) fail('Choose a backup location outside the app data directory.');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  output = await realpath(output);
  if (output === dataDir || output.startsWith(dataDir + path.sep)) fail('Choose a backup location outside the app data directory.');
  const staging = await mkdtemp(path.join(output, '.incomplete-'));
  try {
    snapshotDatabase(path.join(dataDir, 'frameboard.db'), path.join(staging, 'frameboard.db'));
    const { schemaVersion, images: versions, nativeThreads: threads, retainedCount } = inspectBackupDatabase(path.join(staging, 'frameboard.db'));
    if (retainedCount) fail('Retained storage export is not available yet. This backup format cannot preserve retained payloads.');
    await chmod(path.join(staging, 'frameboard.db'), 0o600);
    const files = ['frameboard.db']; const directories = [];
    await inventory(dataDir, 'images', files, directories);
    await inventory(dataDir, 'workspaces', files, directories);
    await inventory(dataDir, 'flows', files, directories);
    for (const version of versions) if (!files.includes(`images/${version.id}`)) fail(`Missing image: ${version.id}`);
    const entries = [];
    for (const directory of directories) await mkdir(path.join(staging, directory), { recursive: true, mode: 0o700 });
    for (const relative of files) {
      const bytes = await regularBytes(relative === 'frameboard.db' ? staging : dataDir, relative);
      const mode = (await lstat(path.join(relative === 'frameboard.db' ? staging : dataDir, relative))).mode & 0o777;
      if (relative.startsWith('images/')) {
        if (!imageIdPattern.test(path.basename(relative)) || bytes.length > maxImageBytes || !imageFormat(bytes)) fail(`Invalid stored image: ${relative}`);
        const version = versions.find((item) => item.id === path.basename(relative));
        if (version?.hash && sha256(bytes) !== version.hash) fail(`Damaged image: ${relative}`);
      }
      if (relative !== 'frameboard.db') await writeFile(path.join(staging, relative), bytes, { flag: 'wx', mode: 0o600 });
      entries.push({ path: relative, size: bytes.length, sha256: sha256(bytes), mode });
    }
    let appRevision = null;
    try { appRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('.', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* A distributed copy may lack Git metadata. */ }
    const native = await selectedNative(codexHome, threads);
    for (const { relative, bytes } of native.files) {
      const destination = `native/codex/${relative}`;
      await mkdir(path.dirname(path.join(staging, destination)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(staging, destination), bytes, { flag: 'wx', mode: 0o600 });
      entries.push({ path: destination, size: bytes.length, sha256: sha256(bytes), mode: 0o600 });
    }
    const manifest = { format: 'frameboard-backup', version: 1, createdAt, appRevision, schemaVersion,
      nativeResume: 'not verified', label: 'History-only backup; native resume not verified.',
      nativeResumeReason: 'Native index dependencies are not copied; restored exact resume has not been proved.',
      nativeMissing: native.missing, directories, files: entries };
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const backupDir = path.join(output, `frameboard-${createdAt.replaceAll(':', '-')}-${path.basename(staging).slice(-6)}`);
    await rename(staging, backupDir);
    return { backupDir, nativeResume: manifest.nativeResume, label: manifest.label };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

function validPath(relative) {
  return typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !relative.includes('\0')
    && !path.posix.isAbsolute(relative) && relative.split('/').every((part) => part && part !== '.' && part !== '..');
}

async function verifiedBackupBytes(root, entry) {
  const bytes = await regularBytes(root, entry.path);
  if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) fail(`Backup hash mismatch: ${entry.path}`);
  return bytes;
}

export async function restoreBackup({ backupDir, dataDir, codexHome }) {
  backupDir = await realpath(backupDir); dataDir = path.resolve(dataDir);
  const manifest = JSON.parse((await regularBytes(backupDir, 'manifest.json')).toString());
  if (manifest.format !== 'frameboard-backup' || manifest.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) fail('Unsupported backup manifest.');
  const appPath = (relative) => relative === 'frameboard.db' || relative === 'images' || relative.startsWith('images/') || relative === 'workspaces' || relative.startsWith('workspaces/')
    || relative === 'flows' || relative.startsWith('flows/');
  const allowed = (relative) => validPath(relative) && (appPath(relative) || relative.startsWith('native/codex/'));
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!allowed(entry.path) || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) fail('Invalid backup file entry.');
    seen.add(entry.path);
    await verifiedBackupBytes(backupDir, entry);
  }
  if (!seen.has('frameboard.db')) fail('The backup database is missing.');
  for (const directory of manifest.directories) if (!validPath(directory) || !appPath(directory) || seen.has(directory) || directory === 'frameboard.db') fail('Invalid backup directory entry.');
  const { images, nativeThreads: threads, retainedCount } = inspectBackupDatabase(path.join(backupDir, 'frameboard.db'));
  if (retainedCount) fail('Retained storage export/restore is not available in this backup format.');
  for (const image of images) {
    const entry = manifest.files.find((item) => item.path === `images/${image.id}`);
    if (!entry) fail(`Missing image: ${image.id}`);
    if (image.hash && image.hash !== entry.sha256) fail(`Damaged image: ${image.id}`);
  }
  for (const entry of manifest.files) if (entry.path.startsWith('native/') && !nativePath(entry.path.slice(13), threads)) fail('Only bound native conversation files may be restored.');
  const existing = await optional(dataDir);
  if (existing && (!existing.isDirectory() || (await readdir(dataDir)).length)) fail('Restore needs a new or empty app data directory. Existing app data will not be overwritten.');
  await mkdir(path.dirname(dataDir), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(path.dirname(dataDir), '.frameboard-restore-'));
  const nativeCopied = []; const nativeSkipped = [];
  try {
    for (const directory of manifest.directories) await mkdir(path.join(staging, directory), { recursive: true, mode: 0o700 });
    for (const entry of manifest.files) {
      if (entry.path.startsWith('native/')) continue;
      const bytes = await verifiedBackupBytes(backupDir, entry);
      await mkdir(path.dirname(path.join(staging, entry.path)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(staging, entry.path), bytes, { flag: 'wx', mode: 0o600 });
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
      const bytes = await verifiedBackupBytes(backupDir, entry);
      try { await writeFile(path.join(root, relative), bytes, { flag: 'wx', mode: 0o600 }); nativeCopied.push(relative); }
      catch (error) { if (error.code !== 'EEXIST') throw error; nativeSkipped.push(relative); }
    }
    await rename(staging, dataDir);
    return { dataDir, nativeResume: 'not verified', label: 'History-only backup; native resume not verified.', nativeCopied, nativeSkipped };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
