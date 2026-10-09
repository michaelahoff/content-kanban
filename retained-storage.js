// Internal boundary for arbitrary originals, saved documents and output payloads.
// Callers pass byte streams and version identities, never authoritative paths.
import { mkdir, open, realpath, rename, rm, readdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const bytesOnly = (chunk) => { if (!(chunk instanceof Uint8Array)) fail(400, 'Supply exact bytes, not decoded text.'); return chunk; };
const inputStream = (source) => source instanceof Uint8Array ? Readable.from([source]) : Readable.from(source);
const digest = () => {
  const hash = createHash('sha256'); let size = 0;
  return {
    stream: new Transform({ transform(chunk, encoding, done) {
      try { bytesOnly(chunk); hash.update(chunk); size += chunk.length; if (!Number.isSafeInteger(size)) fail(413, 'File size exceeds exact integer storage.'); done(null, chunk); }
      catch (error) { done(error); }
    } }),
    result: () => ({ hash: hash.digest('hex'), size }),
  };
};
async function checkParent(filename) {
  if (await realpath(path.dirname(filename)) !== path.dirname(filename)) fail(403, 'Linked storage directories are refused.');
}
async function removeFile(filename) { await checkParent(filename); await rm(filename, { force: true }); }
async function publishFile(source, target) { await checkParent(source); await checkParent(target); await rename(source, target); }
async function syncDirectory(directory) { const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function directory(parent, name) {
  const target = path.join(parent, name);
  await mkdir(target, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) fail(403, 'Retained storage directories cannot be links.');
  await syncDirectory(parent);
  return target;
}
async function regular(filename) {
  if (await realpath(path.dirname(filename)) !== path.dirname(filename)) fail(403, 'Linked retained directories are refused.');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1) fail(403, 'Retained files must be regular independent files.'); return handle; }
  catch (error) { await handle.close(); throw error; }
}
async function writeBytes(filename, source, signal, onFirstWrite = async () => {}) {
  await checkParent(filename);
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const measured = digest(); let firstWrite = true;
  try {
    const sink = new Writable({ write(chunk, encoding, done) {
      (async () => {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error('Retained storage write made no progress.');
          offset += bytesWritten;
        }
        if (firstWrite) { firstWrite = false; await onFirstWrite(); }
      })().then(() => done(), done);
    } });
    await pipeline(inputStream(source), measured.stream, sink, { signal });
    await handle.chmod(0o444);
    await handle.sync();
    return measured.result();
  } finally { await handle.close(); }
}
async function verifyHandle(handle, expected) {
  const before = await handle.stat(); const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let size = 0;
  for (;;) { const read = await handle.read(buffer, 0, buffer.length, size); if (!read.bytesRead) break; hash.update(buffer.subarray(0, read.bytesRead)); size += read.bytesRead; }
  const after = await handle.stat();
  if (size !== expected.size || hash.digest('hex') !== expected.hash || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    fail(409, 'The retained version is unavailable: recorded hash/size verification failed.');
}

// checkpoint is a fault-injection boundary for publication/restart acceptance.
// Recovery must run under exclusive data-directory ownership, before writers.
export async function createRetainedStorage({ dataDir, metadata, checkpoint = async () => {} }) {
  const base = await realpath(dataDir);
  const root = await directory(base, 'retained');
  const staging = await directory(root, 'staging'); const payloads = await directory(root, 'versions');
  const active = new Set();
  const payload = (id) => { if (!uuid.test(id)) fail(400, 'Invalid retained version identity.'); return path.join(payloads, id); };
  const requireVersion = (ctx, id) => {
    const version = metadata.version(ctx, id);
    if (!version) fail(404, 'The retained version does not exist.');
    if (version.state !== 'committed') fail(409, 'The retained version is not committed.');
    return version;
  };
  async function verified(version) {
    let handle;
    try { handle = await regular(payload(version.id)); await verifyHandle(handle, version); metadata.availability(version.id, true); return handle; }
    catch (error) {
      await handle?.close();
      metadata.availability(version.id, false, error.message);
      throw Object.assign(new Error(`Retained version ${version.id} is unavailable. ${error.message}`), { status: 409, cause: error });
    }
  }
  async function exclusive(key, work) {
    if (active.has(key)) fail(409, 'This retained operation is already in progress.');
    active.add(key); try { return await work(); } finally { active.delete(key); }
  }
  const api = {
    version: metadata.version,
    current: metadata.current,
    inventory: metadata.inventory,
    remove: metadata.remove,
    async publish(ctx, descriptor, source, { signal } = {}) {
      return exclusive(`operation:${ctx.workspaceId}:${descriptor.operationId}`, async () => {
        const version = metadata.begin(ctx, descriptor);
        if (version.state === 'committed') return version;
        const temporary = path.join(staging, version.id); const target = payload(version.id);
        try {
          metadata.restart(ctx, version.id);
          await removeFile(temporary); await removeFile(target);
          await checkpoint('staging', version);
          const measured = await writeBytes(temporary, source, signal, () => checkpoint('writing', version));
          metadata.pin(ctx, version.id, measured);
          await checkpoint('staged', { ...version, ...measured });
          signal?.throwIfAborted();
          await publishFile(temporary, target);
          await syncDirectory(payloads); await syncDirectory(staging);
          await checkpoint('bytes-published', { ...version, ...measured });
          metadata.published(ctx, version.id);
          await checkpoint('published', { ...version, ...measured });
          signal?.throwIfAborted();
          const committed = metadata.commit(ctx, version.id);
          // A failure after commit must never undo or misreport a saved sibling.
          await checkpoint('committed', committed);
          return committed;
        } catch (error) {
          const saved = metadata.version(ctx, version.id);
          if (saved.state === 'committed') return saved;
          // Reclaim space before SQLite records ENOSPC; its journal needs room.
          await removeFile(temporary); await removeFile(target);
          metadata.failed(version.id, error.message);
          throw error;
        }
      });
    },
    async publishBatch(ctx, entries, options) {
      const outcomes = [];
      for (const { descriptor, source } of entries) {
        try { outcomes.push({ operationId: descriptor.operationId, version: await api.publish(ctx, descriptor, source, options) }); }
        catch (error) { outcomes.push({ operationId: descriptor.operationId, error: error.message }); }
      }
      return outcomes;
    },
    async read(ctx, id) {
      const version = requireVersion(ctx, id); const handle = await verified(version);
      // Use the verified descriptor: never reopen by a mutable label/path.
      const hash = createHash('sha256'); let size = 0;
      const stream = new Transform({
        transform(chunk, encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk); },
        flush(done) {
          if (size === version.size && hash.digest('hex') === version.hash) return done();
          const error = Object.assign(new Error(`Retained version ${id} changed during reading.`), { status: 409 });
          metadata.availability(id, false, error.message); done(error);
        },
      });
      pipeline(handle.createReadStream({ start: 0, highWaterMark: 64 * 1024, autoClose: true }), stream).catch(() => {});
      return stream;
    },
    // The first bytes of a committed original, not verified: for previews that
    // must not hash a whole large file. Anything delivered is read verified.
    async peek(ctx, id, length) {
      const version = requireVersion(ctx, id);
      const handle = await regular(payload(version.id));
      try {
        const buffer = Buffer.alloc(Math.min(length, version.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead);
      } finally { await handle.close(); }
    },
    async materialize(ctx, id, workspace, relative, { signal } = {}) {
      const version = requireVersion(ctx, id);
      if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')
        || relative.split('/').some((part) => !part || part === '.' || part === '..')) fail(400, 'Use a workspace-relative reference path.');
      const workspaceRoot = await realpath(workspace);
      if (workspaceRoot !== path.resolve(workspace) || !workspaceRoot.startsWith(path.join(base, 'workspaces') + path.sep))
        fail(403, 'References cannot target authoritative storage.');
      let parent = workspaceRoot;
      for (const component of relative.split('/').slice(0, -1)) parent = await directory(parent, component);
      const target = path.join(parent, path.basename(relative));
      const temporary = path.join(parent, `.reference-${randomUUID()}`);
      let source;
      try {
        source = await api.read(ctx, id);
        const measured = await writeBytes(temporary, source, signal);
        if (measured.hash !== version.hash || measured.size !== version.size) fail(409, 'Original bytes changed while copying the reference.');
        await publishFile(temporary, target); await syncDirectory(parent);
        return { versionId: id, hash: version.hash, size: version.size, path: target };
      } finally { source?.destroy(); await removeFile(temporary); }
    },
    async copy(ctx, id, descriptor, options) {
      // Independent identities and bytes, even for identical content.
      if (descriptor.objectId) fail(400, 'An independent copy must create a new retained source.');
      const publication = { ...descriptor, provenance: { ...descriptor.provenance, copiedFromVersionId: id } };
      if (metadata.operation(ctx, descriptor.operationId)?.state === 'committed') return api.publish(ctx, publication, null, options);
      const stream = await api.read(ctx, id);
      try { return await api.publish(ctx, publication, stream, options); }
      finally { stream.destroy(); }
    },
    async repair(ctx, id, source, { signal } = {}) {
      return exclusive(`repair:${id}`, async () => {
        const version = requireVersion(ctx, id); const temporary = path.join(staging, `repair-${randomUUID()}`);
        try {
          const measured = await writeBytes(temporary, source, signal);
          if (measured.hash !== version.hash || measured.size !== version.size) fail(409, 'Repair must match the recorded hash and size exactly.');
          signal?.throwIfAborted();
          metadata.active(ctx, id);
          await publishFile(temporary, payload(id)); await syncDirectory(payloads); await syncDirectory(staging);
          metadata.availability(id, true);
          return metadata.version(ctx, id);
        } finally { await removeFile(temporary); }
      });
    },
  };
  // Only app-owned unfinished bytes are collectible. Committed originals,
  // including removed/superseded/unavailable versions, are never collected.
  const committed = new Set(metadata.committed().map((version) => version.id));
  for (const name of await readdir(staging)) {
    if ((uuid.test(name) || /^repair-[a-f0-9-]{36}$/.test(name)) && !(await lstat(path.join(staging, name))).isDirectory()) await removeFile(path.join(staging, name));
  }
  for (const version of metadata.unfinished()) {
    if (!committed.has(version.id)) await removeFile(payload(version.id));
    metadata.failed(version.id, 'Publication interrupted. Retry the same operation with the original bytes.');
  }
  await syncDirectory(staging); await syncDirectory(payloads);
  return api;
}
