import { mkdir, readFile, writeFile, chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { configurationDiscovery, compileConfiguration } from './codex-configuration.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function createChatService({ store, adapter, dataDir }) {
  const workspace = (cardId) => path.resolve(dataDir, 'workspaces', cardId);
  async function imageBytes(image) {
    let bytes;
    try { bytes = await readFile(path.join(dataDir, 'images', image.id)); }
    catch (error) { if (error.code === 'ENOENT') fail(409, `The reference ${image.name} is missing. Review the selected image versions.`); throw error; }
    if (bytes.length > 20 * 1024 * 1024) fail(409, 'The selected reference exceeds 20 MB.');
    if (image.hash && hash(bytes) !== image.hash) fail(409, `The reference ${image.name} is damaged. Its bytes differ from the frozen version.`);
    return bytes;
  }
  return {
    workspace,
    async preview(ctx, cardId) {
      const captured = store.chats.context(ctx, cardId);
      for (const image of captured.context.images) image.hash = hash(await imageBytes(image));
      return captured;
    },
    async discover(ctx, cardId) {
      store.getCard(ctx, cardId);
      const cwd = workspace(cardId);
      await mkdir(cwd, { recursive: true });
      const discovery = await configurationDiscovery(adapter, { cwd });
      return { discovery, effective: compileConfiguration(store.providerConfiguration(ctx).selection, discovery) };
    },
    async queue(ctx, cardId, input) {
      if (!input || typeof input.id !== 'string' || !/^[\w-]{1,100}$/.test(input.id)) fail(400, 'A browser submission ID is required.');
      const existing = store.chats.findSubmission(ctx, cardId, input.id);
      if (existing) return existing;
      const captured = await this.preview(ctx, cardId);
      const settings = store.providerConfiguration(ctx);
      const { discovery } = await this.discover(ctx, cardId);
      if (!discovery.models.some((model) => model.id === captured.model)) fail(400, 'Choose an available Codex model explicitly.');
      if (settings.revision !== store.providerConfiguration(ctx).revision) fail(409, 'Codex settings changed while preparing Send. Review and send again.');
      return store.chats.queue(ctx, cardId, input, captured, compileConfiguration(settings.selection, discovery));
    },
    async references(submission) {
      const directory = path.join(workspace(submission.cardId), 'references');
      await mkdir(directory, { recursive: true });
      if (await realpath(directory) !== path.join(await realpath(workspace(submission.cardId)), 'references')) fail(409, 'The workspace reference directory was replaced by a link. Restore it before retrying.');
      const input = [];
      for (const image of submission.context.images) {
        const bytes = await imageBytes(image);
        const filename = path.join(directory, `${image.hash}.${image.id.split('.').pop()}`);
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
}
