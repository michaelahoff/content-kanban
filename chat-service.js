import { mkdir, readFile, writeFile, chmod, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { configurationDiscovery, compileConfiguration } from './provider-configuration.js';
import { cardTools } from './card-tools.js';
import { nativeImageBytes, storeImage, readRegularFile, within, sha256 as hash, maxImageBytes, imageFormat } from './image-files.js';
import { referencePath } from './public/chat-context.js';
import { splitExtension } from './public/library-format.js';
import { planInputs, rasterFormats, limits } from './submission-inputs.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// Library text larger than any request can hold is read as a file.
const textProbeBytes = limits.certainTextBytes;
const utf8 = new TextDecoder('utf-8', { fatal: true });
// Workspace copies are named by version, never by the filename label.
export function libraryPath(file) {
  const extension = file.kind === 'image' ? file.format : splitExtension(file.filename)[1].toLowerCase();
  return `references/library/${file.versionId}${/^[a-z0-9]{1,10}$/.test(extension) ? `.${extension}` : ''}`;
}
// One verified read of a Library version, enough to choose its representation:
// a supported raster image, UTF-8 text without NUL bytes, or any other file.
async function classify(stream, size) {
  const chunks = []; let length = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk); length += chunk.length;
      if (size > textProbeBytes && length >= 64) break;
    }
  } finally { stream.destroy(); }
  const bytes = Buffer.concat(chunks);
  const format = imageFormat(bytes);
  if (rasterFormats.includes(format)) return { kind: 'image', format };
  if (size <= textProbeBytes && !bytes.includes(0)) {
    try { utf8.decode(bytes); return { kind: 'text', format: 'utf-8' }; } catch { /* Not text: a file. */ }
  }
  return { kind: 'file', format: format ?? null };
}
const problemMessage = (problems) => `Not sent. ${problems.map((problem) => `${problem.label}: ${problem.reason}`).join(' ')}`;
export function createChatService({ store, adapter, adapters = { codex: adapter }, providers, dataDir }) {
  const workspace = (cardId) => path.resolve(dataDir, 'workspaces', cardId);
  async function imageBytes(image) {
    let bytes;
    try { bytes = await readFile(path.join(dataDir, 'images', image.id)); }
    catch (error) { if (error.code === 'ENOENT') fail(409, `The reference ${image.name} is missing. Review the selected image versions.`); throw error; }
    if (bytes.length > maxImageBytes) fail(409, 'The selected reference exceeds 20 MB.');
    const recorded = store.images.version(image.id)?.hash;
    if (recorded && hash(bytes) !== recorded) fail(409, `The reference ${image.name} is damaged. Its bytes differ from the stored version.`);
    if (image.hash && hash(bytes) !== image.hash) fail(409, `The reference ${image.name} is damaged. Its bytes differ from the frozen version.`);
    return bytes;
  }
  const imagesDir = path.join(dataDir, 'images');
  const service = {
    workspace,
    async importNative(native, nativeHome) { return storeImage(imagesDir, await nativeImageBytes(native, nativeHome)); },
    // register_image: an explicitly named regular file inside the originating
    // card workspace. Reference copies are inputs and cannot be registered.
    async renderedImage(cardId, input) {
      if (!input || typeof input.path !== 'string' || !input.path.length || input.path.length > 4000 || (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 500))) fail(400, 'Choose a rendered image path and name.');
      const root = workspace(cardId); const filename = path.resolve(root, input.path);
      const references = path.join(root, 'references') + path.sep;
      if (await realpath(root) !== root || filename === root || !filename.startsWith(root + path.sep)) fail(403, 'Rendered images must be inside the originating card workspace.');
      if (!(await within(root, filename))) fail(403, 'Rendered image links cannot escape the card workspace.');
      const resolved = await realpath(filename);
      if (filename.startsWith(references) || resolved.startsWith(references)) fail(400, 'Reference copies are inputs, not rendered outputs.');
      const bytes = await readRegularFile(filename);
      // Recheck resolved parents after reading, so a replaced workspace cannot
      // register another card's files through an intermediate directory link.
      if (await realpath(filename) !== resolved || !(await within(root, filename))) fail(403, 'The rendered image path changed during registration.');
      return { ...await storeImage(imagesDir, bytes), name: input.name || path.basename(filename), sourcePath: filename };
    },
    // The shared resolution, preflight and capture for a manual Send and its
    // preview: the card images and selected Library files as one union, checked
    // for existence, ownership, byte integrity and the target's capabilities and
    // known limits. Problems are reported by source; nothing is silently dropped.
    async preview(ctx, cardId) {
      const captured = store.chats.context(ctx, cardId);
      const items = [];
      for (const image of captured.context.images) {
        const bytes = await imageBytes(image);
        image.hash = hash(bytes);
        items.push({ key: `image:${image.id}`, label: `${image.labels.join(', ')}: ${image.name}`, kind: 'image', format: imageFormat(bytes), size: bytes.length });
      }
      const { files, problems } = store.library.resolve(ctx, captured.projectId, captured.librarySelections);
      const library = [];
      for (const file of files) {
        const key = `asset:${file.assetId}`;
        try { library.push({ ...file, ...await classify(await store.retained.read(ctx, file.versionId), file.size) }); }
        catch (error) {
          if (!error.status) throw error;
          problems.push({ key, label: file.filename, phase: 'integrity', reason: `Version ${file.number} is unavailable: its bytes are missing or damaged. Repair it with its exact original bytes.` });
        }
      }
      const textBytes = Buffer.byteLength(captured.prompt) + captured.context.fields.reduce((sum, field) => sum + Buffer.byteLength(String(field.value ?? '')), 0);
      const plan = planInputs(captured.provider, [...items, ...library.map((file) => ({ ...file, key: `asset:${file.assetId}`, label: file.filename }))], { textBytes });
      captured.context.library = plan.inputs.slice(items.length).map(({ key, label, ...file }) => ({ ...file, ...(file.method === 'text' ? {} : { path: libraryPath(file) }) }));
      captured.context.warnings = plan.warnings;
      captured.problems = [...problems, ...plan.problems];
      return captured;
    },
    async previewLane(ctx, cardId, selections) {
      const captured = store.chats.laneContext(ctx, cardId, selections);
      for (const image of captured.context.images) image.hash = hash(await imageBytes(image));
      return captured;
    },
    async discover(ctx, cardId) {
      store.getCard(ctx, cardId);
      const cwd = workspace(cardId);
      await mkdir(cwd, { recursive: true });
      const provider = store.chats.context(ctx, cardId).provider;
      providers?.assertEnabled(ctx, provider);
      const discovery = await configurationDiscovery(adapters[provider], { cwd }, provider);
      return { discovery, effective: compileConfiguration(store.providerConfiguration(ctx, provider).selection, discovery, [], provider) };
    },
    async queue(ctx, cardId, input) {
      if (!input || typeof input.id !== 'string' || !/^[\w-]{1,100}$/.test(input.id)) fail(400, 'A browser submission ID is required.');
      const existing = store.chats.findSubmission(ctx, cardId, input.id);
      if (existing) return existing;
      const captured = await this.preview(ctx, cardId);
      if (captured.problems.length) throw Object.assign(new Error(problemMessage(captured.problems)), { status: 409, problems: captured.problems });
      providers?.assertEnabled(ctx, captured.provider);
      const settings = store.providerConfiguration(ctx, captured.provider);
      const { discovery } = await this.discover(ctx, cardId);
      if (!discovery.models.some((model) => model.id === captured.model)) fail(400, 'Choose an available model in Settings.');
      if (settings.revision !== store.providerConfiguration(ctx, captured.provider).revision) fail(409, 'Provider settings changed while preparing Send. Review and send again.');
      // Revalidated synchronously with the commit: a Library file replaced or
      // removed during preparation is never sent at its stale version.
      const current = store.library.resolve(ctx, captured.projectId, store.chats.context(ctx, cardId).librarySelections);
      if (current.problems.length || current.files.map((file) => file.versionId).join() !== captured.context.library.map((file) => file.versionId).join()) fail(409, 'A selected Library file changed while preparing Send. Review and send again.');
      return store.chats.queue(ctx, cardId, input, captured, compileConfiguration(settings.selection, discovery, cardTools, captured.provider));
    },
    // A lane run's frozen submission: the playbook's prompt, selections and
    // field authority with the provider configuration current at queue time.
    async queueLane(ctx, cardId, { id, prompt, provider, model, selections, authority, lane }) {
      const existing = store.chats.findSubmission(ctx, cardId, id);
      if (existing) return existing;
      const captured = await this.previewLane(ctx, cardId, selections);
      providers?.assertEnabled(ctx, provider);
      const settings = store.providerConfiguration(ctx, provider);
      const cwd = workspace(cardId);
      await mkdir(cwd, { recursive: true });
      const discovery = await configurationDiscovery(adapters[provider], { cwd }, provider);
      if (!discovery.models.some((entry) => entry.id === model)) fail(409, `The model ${model} is not available for ${provider === 'claude' ? 'Claude' : 'Codex'}. Choose another model in the playbook or card chat.`);
      if (settings.revision !== store.providerConfiguration(ctx, provider).revision) fail(409, 'Provider settings changed while preparing the lane run.');
      return store.chats.queueLane(ctx, cardId, { id }, { ...captured, prompt, provider, model, authority,
        lane: { ...lane, fieldVersions: captured.versions } }, compileConfiguration(settings.selection, discovery, cardTools, provider));
    },
    // Verified Library inputs for one delivery attempt: inline text, and
    // independent workspace copies rebuilt from the frozen versions for images
    // and tool-readable files. A missing or damaged original stops the attempt.
    async libraryInputs(ctx, submission) {
      const texts = new Map(); const attachments = []; const delivery = [];
      for (const file of submission.context.library ?? []) {
        try {
          if (file.method === 'text') {
            const chunks = [];
            for await (const chunk of await store.retained.read(ctx, file.versionId)) chunks.push(chunk);
            texts.set(file.versionId, utf8.decode(Buffer.concat(chunks)));
          } else {
            await mkdir(workspace(submission.cardId), { recursive: true });
            const copy = await store.retained.materialize(ctx, file.versionId, workspace(submission.cardId), file.path);
            if (file.method === 'image') attachments.push({ type: 'localImage', path: copy.path });
          }
          delivery.push({ versionId: file.versionId, filename: file.filename, method: file.method, status: 'prepared' });
        } catch (error) {
          if (!error.status) throw error;
          delivery.push({ versionId: file.versionId, filename: file.filename, method: file.method, status: 'failed', reason: error.message });
          const remaining = (submission.context.library ?? []).slice(delivery.length).map((entry) => ({ versionId: entry.versionId, filename: entry.filename, method: entry.method, status: 'not-sent' }));
          throw Object.assign(new Error(`${file.filename} version ${file.versionId} could not be delivered: ${error.message} Repair it with its exact original bytes, then Retry.`), { kind: 'input-unavailable', delivery: [...delivery, ...remaining] });
        }
      }
      return { texts, attachments, delivery };
    },
    async references(submission) {
      const directory = path.join(workspace(submission.cardId), 'references');
      await mkdir(directory, { recursive: true });
      if (await realpath(directory) !== path.join(await realpath(workspace(submission.cardId)), 'references')) fail(409, 'The workspace reference directory was replaced by a link. Restore it before retrying.');
      const input = [];
      for (const image of submission.context.images) {
        const bytes = await imageBytes(image);
        const filename = path.join(workspace(submission.cardId), referencePath(image));
        // A harness can modify its workspace. Verify and repair reference copies
        // from the authoritative version before each turn.
        try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o444 }); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const info = await lstat(filename);
          if (!info.isFile() || info.nlink !== 1) fail(409, 'The workspace reference was replaced by a link or another file type. Restore it before retrying.');
          if (hash(await readFile(filename)) !== image.hash) {
            await unlink(filename);
            await writeFile(filename, bytes, { flag: 'wx', mode: 0o444 });
          }
        }
        await chmod(filename, 0o444);
        input.push({ type: 'localImage', path: filename });
      }
      return input;
    },
  };
  // Finish filesystem operations before the app releases its backup/restore
  // lock. Native events can already have started an import when shutdown begins.
  const pending = new Set();
  for (const name of ['importNative', 'renderedImage', 'preview', 'previewLane', 'discover', 'queue', 'queueLane', 'references', 'libraryInputs']) {
    const operation = service[name];
    service[name] = function (...args) {
      const task = operation.apply(this, args);
      pending.add(task);
      task.finally(() => pending.delete(task)).catch(() => {});
      return task;
    };
  }
  service.drain = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  return service;
}
