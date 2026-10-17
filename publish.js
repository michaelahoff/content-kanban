// The publish lane action (ADR 0011): copies a card's saved outputs to a site.
// It runs in Frameboard itself, outside the agent boundary, on purpose. An
// agent works inside the retained-data boundary (ADR 0004): public HTTP(S)
// only, no SSH, no keys and nothing on this computer but its card workspace,
// so it cannot write a served folder or reach a VPS. Frameboard can, with
// settings the user wrote in a lane playbook and only the bytes earlier lanes
// saved. This is the only module that writes sites.
//
//   const publisher = createPublisher({ dataDir });
//   publisher.root                      → <dataDir>/sites
//   await publisher.file(relativePath)  → { path, size, type, kind, stream } for a published file, or null
//   await publisher.publish({ store, ctx, card, settings, run }) → { status: 'published' | 'failed', url, files, command, message }
//
// A local site is data/sites/<site>/<slug>/, served by the server under
// /sites/ as sandboxed pages. A remote target (user@host:/path) is staged here
// and sent with rsync, which uses this computer's own SSH keys.
import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { previewType, splitExtension } from './public/library-format.js';
import { slug } from './playbooks.js';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const remoteShape = /^[^\s@:/]+@[^\s@:/]+:\/.+$/;
// What Frameboard passes to rsync and so to ssh and the remote shell: a user
// and host that cannot be read as options, and a path without shell syntax.
const remoteSafe = /^[a-z0-9_][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*:\/[a-z0-9._~/+-]*$/i;
const siteName = /^[a-z0-9][a-z0-9_-]{0,59}$/i;
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
// Shell quoting for the recorded command only; rsync is spawned without a shell.
const quoted = (arg) => (/^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

// A saved output's filename is a label. On a site it becomes one file name in
// the post's folder: no separators or control characters, and no leading dot,
// so nothing published is hidden or read as server configuration (.htaccess).
function siteFilename(label) {
  const name = String(label).normalize('NFC').replace(/[/\\\u0000-\u001f\u007f]/g, '-').trim().replace(/^\.+/, '').trim() || 'file';
  // File systems allow 255 bytes; a shortened name keeps its extension.
  const [base, extension] = splitExtension(name); const suffix = extension ? `.${extension}` : '';
  let short = base;
  while (short && Buffer.byteLength(short + suffix) > 255) short = [...short].slice(0, -1).join('');
  return short ? `${short}${suffix}` : 'file';
}

// The last lines rsync wrote to stderr, for a failure message.
const errorTail = (text) => text.trim().split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join(' ').slice(-600);

// Runs rsync in its own session: with no controlling terminal, ssh cannot
// stop to ask for a password or host key, so a missing key fails at once.
function runRsync(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stderr = ''; let timedOut = false; let child;
    try { child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true }); }
    catch (error) { resolve({ code: null, error, stderr }); return; }
    const stop = (signal) => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
    const timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); setTimeout(() => stop('SIGKILL'), 2000).unref(); }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, error, stderr }); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, stderr }); });
  });
}

export function createPublisher({ dataDir, rsync = 'rsync', timeoutMs = 20000 }) {
  const root = path.join(dataDir, 'sites');

  // A published file by its path under /sites/: segments only (no empty, .
  // or .. part, no leading dot, so staging folders stay unseen), a folder
  // meaning its index.html, and a regular file that is no symlink and really
  // lies under the sites folder. Folders are never listed.
  async function file(relative) {
    if (typeof relative !== 'string' || !relative || relative.length > 2048 || /[\\\0]/.test(relative)) return null;
    const parts = relative.split('/');
    if (parts.at(-1) === '') parts[parts.length - 1] = 'index.html';
    if (parts.some((part) => !part || part.startsWith('.'))) return null;
    let target = path.join(root, ...parts);
    let realRoot;
    try { realRoot = await realpath(root); } catch { return null; }
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle;
      try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'ENAMETOOLONG'].includes(error.code)) return null; throw error; }
      try {
        const info = await handle.stat();
        if (info.isDirectory() && attempt === 0) { await handle.close(); target = path.join(target, 'index.html'); continue; }
        // A folder on the way may be a symlink, which O_NOFOLLOW does not see.
        const real = await realpath(target).catch(() => null);
        const same = real && await stat(real).then((found) => found.dev === info.dev && found.ino === info.ino, () => false);
        if (!info.isFile() || !same || !real.startsWith(`${realRoot}${path.sep}`)) { await handle.close(); return null; }
        const preview = previewType(path.basename(real));
        // The handle opened here is what is sent. A HEAD request never takes
        // the stream, so an untaken handle closes itself shortly after.
        let stream = null;
        const untaken = setTimeout(() => { if (!stream) void handle.close().catch(() => {}); }, 1000);
        untaken.unref();
        return { path: real, size: info.size, type: preview?.type ?? 'application/octet-stream', kind: preview?.kind ?? null,
          get stream() { clearTimeout(untaken); return (stream ??= handle.createReadStream()); } };
      } catch (error) { await handle.close().catch(() => {}); throw error; }
    }
    return null;
  }

  // Where `to` sends a post: a remote rsync destination or a local site name.
  function targetOf(to) {
    const value = String(to ?? '').trim();
    if (remoteShape.test(value)) {
      if (!remoteSafe.test(value)) fail(400, `publish: “${value}” is not a destination Frameboard passes to rsync. Write user@host:/path using only letters, numbers, dots, dashes, underscores, ~ and / in it.`);
      return { remote: true, to: value.replace(/\/+$/, '') };
    }
    if (!siteName.test(value)) fail(400, `publish: to must be a site folder name (letters, numbers, - and _, up to 60, such as blog) or user@host:/path for rsync, not “${value}”.`);
    return { remote: false, to: value };
  }

  // The post's address: the first page, so the link opens it.
  function postUrl(base, files) {
    const pages = files.filter((name) => /\.html?$/i.test(name));
    return !files.includes('index.html') && pages.length === 1 ? `${base}${encodeURIComponent(pages[0])}` : base;
  }

  async function publish({ store, ctx, card, settings, run }) {
    const target = targetOf(settings.publish?.to);
    const given = settings.publish?.url ? settings.publish.url.replace(/\/+$/, '') : null;
    // Each filename's newest saved version; a later save replaces an earlier one.
    const chosen = new Map();
    for (const output of store.savedOutputs.list(ctx, card.id).filter((item) => item.status === 'saved').reverse()) {
      const name = siteFilename(output.filename);
      if (!chosen.has(name)) chosen.set(name, output);
    }
    if (!chosen.size) fail(409, 'Nothing to publish: this card has no saved outputs. A lane before this one must save the finished files under outputs.');
    const titled = /[a-z0-9]/.test(String(card.title ?? '').toLowerCase().normalize('NFKD'));
    const postSlug = titled ? slug(card.title) : slug(card.id);
    const files = [...chosen.keys()].sort();
    await mkdir(path.join(root, '.staging'), { recursive: true });
    const staging = await mkdtemp(path.join(root, '.staging', `${run?.id ?? 'run'}-`));
    try {
      // Verified bytes only: the retained store checks each version as it reads.
      for (const [name, output] of chosen) {
        const { stream } = await store.savedOutputs.content(ctx, card.id, output.id);
        await pipeline(stream, createWriteStream(path.join(staging, name), { flags: 'wx', mode: 0o644 }));
        await chmod(path.join(staging, name), 0o644);
      }
      // rsync -a copies modes: a web server must be able to read the post.
      await chmod(staging, 0o755);
      if (!target.remote) {
        const site = path.join(root, target.to);
        await mkdir(site, { recursive: true });
        const destination = path.join(site, postSlug);
        // Swap folders so a reader sees the old post or the new one, never half.
        const aside = path.join(site, `.${postSlug}.${randomUUID()}.old`);
        let replaced = false;
        try { await rename(destination, aside); replaced = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { await rename(staging, destination); }
        catch (error) { if (replaced) await rename(aside, destination).catch(() => {}); throw error; }
        if (replaced) await rm(aside, { recursive: true, force: true });
        const url = postUrl(`${given ?? `/sites/${target.to}`}/${postSlug}/`, files);
        return { status: 'published', url, files, command: null, message: `Published ${plural(files.length, 'file')} to ${url}.` };
      }
      const destination = `${target.to}/${postSlug}/`;
      const args = ['-az', '--delete', `${staging}/`, destination];
      const command = [rsync, ...args].map(quoted).join(' ');
      const url = given ? postUrl(`${given}/${postSlug}/`, files) : null;
      const outcome = await runRsync(rsync, args, timeoutMs);
      if (outcome.code === 0) {
        return { status: 'published', url, files, command,
          message: `Published ${plural(files.length, 'file')} to ${destination} with rsync${url ? `, served at ${url}` : ''}.` };
      }
      const said = errorTail(outcome.stderr);
      const why = outcome.error ? (outcome.error.code === 'ENOENT' ? `rsync is not installed on this computer (${outcome.error.message})` : `rsync could not start: ${outcome.error.message}`)
        : outcome.timedOut ? `rsync did not finish within ${(timeoutMs / 1000).toLocaleString('en-US')} seconds and was stopped${said ? `; it said “${said}”` : ''}`
          : `rsync exited with ${outcome.code === null ? `signal ${outcome.signal}` : `code ${outcome.code}`}${said ? `: “${said}”` : ' without saying why'}`;
      // rsync exits 255 when ssh itself failed: no key, unknown host, refused.
      const hint = outcome.code === 255 ? ' Check that this computer reaches the host with its own SSH key.' : '';
      return { status: 'failed', url: null, files, command, message: `Could not publish to ${destination}: ${why}.${hint}` };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  return { root, file, publish };
}
