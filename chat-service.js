import { mkdir, readFile, writeFile, chmod, lstat, realpath, unlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { configurationDiscovery, compileConfiguration } from './codex-configuration.js';
import { cardTools } from './card-tools.js';

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
    async renderedImage(cardId, input) {
      if (!input || typeof input.path !== 'string' || !input.path.length || input.path.length > 4000 || (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 500))) fail(400, 'Choose a rendered image path and name.');
      const root = workspace(cardId); const filename = path.resolve(root, input.path);
      if (await realpath(root) !== root || filename === root || !filename.startsWith(root + path.sep)) fail(403, 'Rendered images must be inside the originating card workspace.');
      const resolved = await realpath(filename);
      if (!resolved.startsWith(root + path.sep)) fail(403, 'Rendered image links cannot escape the card workspace.');
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 20 * 1024 * 1024) fail(400, 'Rendered images must be regular files under 20 MB.');
        const buffer = Buffer.alloc(20 * 1024 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
        if (length > 20 * 1024 * 1024) fail(400, 'Rendered images must be under 20 MB.');
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
      const extension = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'jpg'
          : /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6)) ? 'gif'
            : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
              : bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32)) ? 'avif' : null;
      if (!extension) fail(400, 'This rendered file is not a supported image.');
      // Recheck resolved parents after reading, so a replaced workspace cannot
      // register another card's files through an intermediate directory link.
      if (await realpath(filename) !== resolved || !resolved.startsWith(await realpath(root) + path.sep)) fail(403, 'The rendered image path changed during registration.');
      const id = `${randomUUID()}.${extension}`;
      await writeFile(path.join(dataDir, 'images', id), bytes, { flag: 'wx', mode: 0o444 });
      return { id, hash: hash(bytes), name: input.name || path.basename(filename), provider: 'codex', creationMethod: 'rendered', sourcePath: filename };
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
      return store.chats.queue(ctx, cardId, input, captured, compileConfiguration(settings.selection, discovery, cardTools));
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
