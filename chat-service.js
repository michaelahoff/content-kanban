import { mkdir, readFile, writeFile, chmod, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { configurationDiscovery, compileConfiguration } from './provider-configuration.js';
import { cardTools } from './card-tools.js';
import { nativeImageBytes, storeImage, readRegularFile, within, sha256 as hash, maxImageBytes } from './image-files.js';
import { referencePath } from './public/chat-context.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
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
    async preview(ctx, cardId) {
      const captured = store.chats.context(ctx, cardId);
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
      providers?.assertEnabled(ctx, captured.provider);
      const settings = store.providerConfiguration(ctx, captured.provider);
      const { discovery } = await this.discover(ctx, cardId);
      if (!discovery.models.some((model) => model.id === captured.model)) fail(400, 'Choose an available model in Settings.');
      if (settings.revision !== store.providerConfiguration(ctx, captured.provider).revision) fail(409, 'Provider settings changed while preparing Send. Review and send again.');
      return store.chats.queue(ctx, cardId, input, captured, compileConfiguration(settings.selection, discovery, cardTools, captured.provider));
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
  for (const name of ['importNative', 'renderedImage', 'preview', 'discover', 'queue', 'references']) {
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
