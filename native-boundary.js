// The complete native process tree is confined, including commands whose
// native sandbox has been relaxed by a permission approval or Full grant.
import { spawn } from 'node:child_process';
import { lstat, realpath, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachNativeProxy } from './native-proxy.js';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const held = (message) => Object.assign(new Error(`Retained-data protection hold: ${message}`), { kind: 'configuration-unavailable', status: 409 });
function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
async function independentTree(root) {
  let info;
  try { info = await lstat(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink()) return; // Links are resolved under the confined policy.
  if (info.isFile() && info.nlink !== 1) throw held(`Remove the external hard link in ${root}; workspace and native-state files must be independent copies.`);
  if (!info.isDirectory()) return;
  let names;
  try { names = await readdir(root); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names) await independentTree(path.join(root, name));
}
export async function createNativeBoundary({ dataDir, nativeHome, testPorts = [] }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw held('This OS/architecture is unproven. Use Linux x64 with bubblewrap, a C compiler and Landlock ABI 10+.');
  dataDir = await realpath(dataDir);
  await mkdir(nativeHome, { recursive: true });
  nativeHome = await realpath(nativeHome);
  const workspaces = path.join(dataDir, 'workspaces');
  await mkdir(workspaces, { recursive: true });
  if (nativeHome === dataDir || nativeHome.startsWith(dataDir + path.sep) || dataDir.startsWith(nativeHome + path.sep)) throw held('Move native state outside the retained data directory; these authorities must be disjoint.');
  const build = await mkdtemp(path.join(tmpdir(), 'frameboard-guard-'));
  const guard = path.join(build, 'guard');
  try {
    const compiled = await collect(spawn('cc', ['-O2', '-Wall', '-Wextra', '-Werror', path.join(appRoot, 'scripts/native-guard.c'), '-o', guard], { stdio: ['ignore', 'pipe', 'pipe'] }));
    if (compiled.code !== 0) throw held('Install a C compiler and Linux headers with Landlock ABI 10 support.');
    const api = {
      snapshot: { policy: 'linux-retained-v1', supported: true, fullAccess: true },
      async check() {
        if (await realpath(dataDir) !== dataDir || await realpath(workspaces) !== workspaces || await realpath(nativeHome) !== nativeHome) throw held('A protected directory was replaced by a link. Restore the directory and restart Frameboard.');
        await independentTree(workspaces); await independentTree(nativeHome);
      },
      launch(command, args, { cwd, env = process.env, ...options } = {}) {
        const guardArgs = [process.execPath, path.join(appRoot, 'scripts/native-proxy-client.mjs'), command, ...args];
        // Credentials come from native sign-in, never the application's env.
        const cleanEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));
        cleanEnv.TMPDIR = '/tmp';
        const child = spawn('bwrap', ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net',
          '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
          ...['/home', '/root', '/run', '/tmp', '/var/tmp'].filter(existsSync).flatMap((dir) => ['--tmpfs', dir]),
          '--ro-bind', path.dirname(process.execPath), path.dirname(process.execPath), '--ro-bind', appRoot, appRoot,
          '--ro-bind', dataDir, dataDir, '--ro-bind', build, build, '--bind', nativeHome, nativeHome, '--bind', workspaces, workspaces,
          '--chdir', cwd ?? appRoot, '--', guard, ...guardArgs], { ...options, stdio: [...(options.stdio ?? ['pipe', 'pipe', 'pipe']), 'pipe'], cwd: appRoot, env: cleanEnv });
        attachNativeProxy(child.stdio[3], { testPorts });
        return child;
      },
      async run(command, args, options = {}) {
        await this.check();
        return collect(this.launch(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }));
      },
      close: () => rm(build, { recursive: true, force: true }),
    };
    const probe = await api.run('/bin/true', []);
    if (probe.code !== 0) throw held(`Enable unprivileged bubblewrap and Landlock ABI 10+. The enforced native launch probe failed: ${probe.stderr.slice(0, 1000)}`);
    return api;
  } catch (error) {
    await rm(build, { recursive: true, force: true });
    throw error.kind ? error : held('Install bubblewrap, a C compiler and Linux headers, and enable Landlock ABI 10+.');
  }
}
