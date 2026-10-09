import { mkdir, readFile, writeFile, chmod, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { configurationDiscovery, compileConfiguration } from './provider-configuration.js';
import { cardTools } from './card-tools.js';
import { nativeImageBytes, storeImage, readRegularFile, within, sha256 as hash, maxImageBytes, imageFormat } from './image-files.js';
import { referencePath } from './public/chat-context.js';
import { sourceKey } from './public/library-format.js';
import { planInputs, hasShellTool, noShellTool, problemMessage } from './submission-inputs.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// What a resolution captures: the selections with their paths, and each
// file's identity, version, label and every selecting source.
// A preflight's problems refuse the whole submission, and its Library capture
// must still match the sources resolved synchronously with the commit: a file
// replaced, renamed, moved, added or removed while preflight read it is never
// sent with stale versions, labels or folder membership.
function assertSendable(captured, current, changed) {
  if (captured.problems.length) throw Object.assign(new Error(problemMessage(captured.problems)), { status: 409, problems: captured.problems });
  if (current && (current.problems.length || membershipKey(current.files, current.selections) !== membershipKey(captured.context.library, captured.context.librarySelections))) fail(409, changed);
}
const membershipKey = (files, selections) => JSON.stringify([selections, files.map(({ assetId, versionId, libraryPath, sources }) => [assetId, versionId, libraryPath, sources])]);
export function createChatService({ store, adapter, adapters = { codex: adapter }, providers, dataDir }) {
  const workspace = (cardId) => path.resolve(dataDir, 'workspaces', cardId);
  async function imageBytes(image) {
    let bytes;
    try { bytes = await readFile(path.join(dataDir, 'images', image.id)); }
    catch (error) { if (error.code === 'ENOENT') fail(409, `The reference ${image.name} is missing. Review the selected image versions.`); throw error; }
    if (bytes.length > maxImageBytes) throw Object.assign(new Error('The selected reference exceeds 20 MB.'), { status: 409, phase: 'limit' });
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
    // The shared resolution, preflight and capture for a manual Send, a lane
    // run and their previews: the card images and selected Library files as
    // one union, checked for existence, ownership, byte integrity and the
    // target's capabilities and known limits. Problems are reported by source;
    // nothing is silently dropped. Sends verify every byte against the model
    // and tools they discovered; a preview samples large files and uses the
    // saved provider catalog.
    async preflight(ctx, captured, { selections, savedOutputs = [], provider, model, prompt, verify = false, discovery }) {
      discovery ??= store.providerCatalog(ctx, provider).discovery;
      const models = discovery?.models ?? [];
      const items = []; const imageProblems = [];
      for (const image of captured.context.images) {
        const key = `image:${image.id}`; const label = `${image.labels.join(', ')}: ${image.name}`;
        let bytes;
        try { bytes = await imageBytes(image); }
        catch (error) { if (error.status !== 409) throw error; imageProblems.push({ key, label, phase: error.phase ?? 'integrity', reason: error.message }); continue; }
        image.hash = hash(bytes);
        items.push({ key, label, kind: 'image', format: imageFormat(bytes), size: bytes.length });
      }
      const resolved = store.library.resolve(ctx, captured.projectId, selections);
      const { files } = resolved; const problems = [...imageProblems, ...resolved.problems];
      const library = [];
      for (const file of files) {
        const key = sourceKey({ kind: 'asset', id: file.assetId });
        try { library.push({ ...file, key, label: file.filename, ...await store.library.inspect(ctx, file.projectId, file.versionId, { verify }) }); }
        catch (error) {
          if (!error.status) throw error;
          problems.push({ key, label: file.filename, phase: 'integrity', reason: `Version ${file.number} is unavailable: its bytes are missing or damaged. Repair it with its exact original bytes.` });
        }
      }
      // Reused saved outputs of this card chat come last, in selection order.
      const reusable = store.savedOutputs.resolve(ctx, captured.cardId, savedOutputs);
      problems.push(...reusable.problems);
      const reused = [];
      for (const output of reusable.files) {
        const key = `output:${output.outputId}`;
        try { reused.push({ ...output, projectId: captured.projectId, key, label: output.filename, ...await store.savedOutputs.delivery.inspect(ctx, captured.projectId, output.versionId, { verify }) }); }
        catch (error) {
          if (!error.status) throw error;
          problems.push({ key, label: output.filename, phase: 'integrity', reason: 'Its saved bytes are missing or damaged, and nothing else is ever sent in their place. Remove it from this prompt, or save its reply again as a new document and use that.' });
        }
      }
      const textBytes = Buffer.byteLength(prompt) + captured.context.fields.reduce((sum, field) => sum + Buffer.byteLength(String(field.value ?? '')), 0);
      const plan = planInputs(provider, [...items, ...library, ...reused], { textBytes, model: models.find((entry) => entry.id === model), shellTool: hasShellTool(discovery) });
      const frozen = (inputs, copies) => inputs.map(({ key, label, ...file }) => ({ ...file, ...(file.method === 'text' ? {} : { path: copies.copyPath(file) }) }));
      captured.context.library = frozen(plan.inputs.slice(items.length, items.length + library.length), store.library);
      captured.context.savedOutputs = frozen(plan.inputs.slice(items.length + library.length), store.savedOutputs.delivery);
      captured.context.librarySelections = resolved.selections;
      captured.context.warnings = plan.warnings;
      captured.problems = [...problems, ...plan.problems];
      return captured;
    },
    async preview(ctx, cardId, { verify = false, discovery } = {}) {
      const captured = store.chats.context(ctx, cardId);
      return this.preflight(ctx, captured, { selections: captured.librarySelections, savedOutputs: captured.savedOutputSelections, provider: captured.provider, model: captured.model, prompt: captured.prompt, verify, discovery });
    },
    // A lane run's inputs: every gallery photo, then the playbook's Library
    // sources, checked like a manual Send for the lane's provider and model.
    async previewLane(ctx, cardId, { selections, assets, provider, model, prompt, verify = false, discovery }) {
      return this.preflight(ctx, store.chats.laneContext(ctx, cardId, selections), { selections: assets, provider, model, prompt, verify, discovery });
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
      // State at Send: preparation that spans an archive, or any change to the
      // card, composer or conversation, queues nothing.
      const start = store.chats.context(ctx, cardId);
      providers?.assertEnabled(ctx, start.provider);
      const settings = store.providerConfiguration(ctx, start.provider);
      const { discovery } = await this.discover(ctx, cardId);
      const captured = await this.preview(ctx, cardId, { verify: true, discovery });
      if (captured.archiveGeneration !== start.archiveGeneration) fail(409, 'The project was archived while preparing Send, so it was not sent. Review and send again.');
      if (['composerRevision', 'cardRevision', 'conversationId'].some((key) => captured[key] !== start[key])) fail(409, 'The card, composer or conversation changed while preparing Send. Review and send again.');
      if (!discovery.models.some((model) => model.id === captured.model)) fail(400, 'Choose an available model in Settings.');
      assertSendable(captured);
      if (settings.revision !== store.providerConfiguration(ctx, start.provider).revision) fail(409, 'Provider settings changed while preparing Send. Review and send again.');
      assertSendable(captured, store.library.resolve(ctx, captured.projectId, store.chats.context(ctx, cardId).librarySelections), 'A selected Library file changed while preparing Send. Review and send again.');
      return store.chats.queue(ctx, cardId, input, captured, compileConfiguration(settings.selection, discovery, cardTools, captured.provider));
    },
    // A lane run's frozen submission: the playbook's prompt, selections and
    // field authority with the provider configuration current at queue time.
    // confirm() runs synchronously with the commit, after every asynchronous
    // check, so the caller can refuse inputs that changed meanwhile.
    async queueLane(ctx, cardId, { id, prompt, provider, model, selections, assets = [], authority, lane, confirm = () => {} }) {
      const existing = store.chats.findSubmission(ctx, cardId, id);
      if (existing) return existing;
      providers?.assertEnabled(ctx, provider);
      const settings = store.providerConfiguration(ctx, provider);
      const cwd = workspace(cardId);
      await mkdir(cwd, { recursive: true });
      const discovery = await configurationDiscovery(adapters[provider], { cwd }, provider);
      if (!discovery.models.some((entry) => entry.id === model)) fail(409, `The model ${model} is not available for ${provider === 'claude' ? 'Claude' : 'Codex'}. Choose another model in the playbook or card chat.`);
      const captured = await this.previewLane(ctx, cardId, { selections, assets, provider, model, prompt, verify: true, discovery });
      assertSendable(captured);
      confirm();
      if (settings.revision !== store.providerConfiguration(ctx, provider).revision) fail(409, 'Provider settings changed while preparing the lane run.');
      assertSendable(captured, store.library.resolve(ctx, captured.projectId, assets), 'A selected Library file changed while preparing the lane run.');
      return store.chats.queueLane(ctx, cardId, { id }, { ...captured, prompt, provider, model, authority,
        lane: { ...lane, fieldVersions: captured.versions } }, compileConfiguration(settings.selection, discovery, cardTools, provider));
    },
    // Everything one delivery attempt sends besides its text: the card's image
    // references, then verified Library inputs and reused saved outputs (inline
    // text, and independent workspace copies rebuilt from the frozen versions,
    // sent as native images or Claude PDF documents). An original that cannot
    // be delivered stops the attempt, recording what happened to each input.
    async deliveryInputs(ctx, submission) {
      const library = submission.context.library ?? [];
      const outputs = submission.context.savedOutputs ?? [];
      const entry = (file) => ({ versionId: file.versionId, filename: file.filename, method: file.method, ...(['copy', 'document'].includes(file.method) ? { format: file.format } : {}) });
      const delivery = [...submission.context.images.map((image) => ({ imageId: image.id, filename: image.name, method: 'image' })),
        ...library.map(entry), ...outputs.map((output) => ({ outputId: output.outputId, ...entry(output) }))];
      const stopped = (failed, reason) => delivery.map((entry) => ({ ...entry, status: entry === failed ? 'failed' : 'not-sent', reason }));
      let nativeInputs;
      try { nativeInputs = await this.references(submission); }
      catch (error) { throw Object.assign(error, { delivery: stopped(null, error.message) }); }
      const texts = new Map();
      const sources = [...library.map((file) => [file, store.library]), ...outputs.map((output) => [output, store.savedOutputs.delivery])];
      for (const [index, [file, reads]] of sources.entries()) {
        try {
          if (file.method === 'text') texts.set(file.versionId, await reads.text(ctx, file.projectId, file.versionId));
          else {
            const copy = await reads.materialize(ctx, file.projectId, file.versionId, workspace(submission.cardId), file.path);
            if (file.method === 'image') nativeInputs.push({ type: 'localImage', path: copy.path });
            if (file.method === 'document') nativeInputs.push({ type: 'localDocument', path: copy.path });
          }
        } catch (error) {
          throw Object.assign(new Error(`${file.filename} version ${file.versionId} could not be delivered: ${error.message} Repair it with its exact original bytes if it is damaged, then Retry.`), { kind: 'input-unavailable',
            delivery: stopped(delivery[submission.context.images.length + index], error.message) });
        }
      }
      return { texts, nativeInputs, delivery };
    },
    // Immediately before sending, each frozen route must still exist on the
    // actual target: a workspace copy needs Codex's shell tool, and a PDF needs
    // the Claude model's evidence-backed route. Without it the attempt stops,
    // naming each such file, rather than sending a path or a subset.
    assertRoutes(submission, discovery, delivery) {
      const library = [...submission.context.library ?? [], ...submission.context.savedOutputs ?? []];
      const pdf = discovery.models?.find((model) => model.id === submission.model)?.pdf;
      const [method, reason] = submission.provider === 'codex' ? ['copy', hasShellTool(discovery) ? null : `${noShellTool}, then Retry.`]
        : ['document', pdf?.available ? null : `Claude PDF delivery is not enabled here: ${pdf?.reason ?? 'this Claude setup reported no PDF route.'} Use the checked setup, then Retry.`];
      const stranded = reason ? library.filter((file) => file.method === method) : [];
      if (!stranded.length) return;
      const names = new Set(stranded.map((file) => file.versionId));
      throw Object.assign(new Error(`${stranded.map((file) => file.filename).join(', ')} could not be delivered. ${reason}`), { kind: 'input-unavailable',
        delivery: delivery.map((entry) => ({ ...entry, status: names.has(entry.versionId) ? 'failed' : 'not-sent', reason })) });
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
  for (const name of ['importNative', 'renderedImage', 'preflight', 'preview', 'previewLane', 'discover', 'queue', 'queueLane', 'references', 'deliveryInputs']) {
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
