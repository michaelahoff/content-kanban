import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createNativeBoundary } from '../native-boundary.js';
import http from 'node:http';
import net from 'node:net';

const enabled = process.env.FRAMEBOARD_NATIVE_TEST === '1';

test('confined native processes preserve authoritative bytes through direct and linked writes while notes stay mutable', { skip: !enabled }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data'); const home = path.join(root, 'native');
  const workspace = path.join(dataDir, 'workspaces', 'card');
  await mkdir(workspace, { recursive: true }); await mkdir(home);
  const original = path.join(dataDir, 'original');
  await writeFile(original, 'retained original');
  await symlink(original, path.join(workspace, 'escape'));
  const boundary = await createNativeBoundary({ dataDir, nativeHome: home });
  t.after(() => boundary.close());
  const result = await boundary.run('/bin/sh', ['-c', `
    printf corrupted > '${original}'
    printf corrupted > escape
    ln '${original}' alias && printf corrupted > alias
    rm '${original}'
    printf corrupted > '/proc/1/root${original}'
    bwrap --unshare-user --bind / / /bin/sh -c "mount -o remount,rw /; printf corrupted > '${original}'"
    printf notes > notes.md
  `], { cwd: workspace });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(original, 'utf8'), 'retained original');
  assert.equal(await readFile(path.join(workspace, 'notes.md'), 'utf8'), 'notes');
  // An alias planted by an external process must hold rather than make its
  // authoritative inode writable through an allowed workspace mount.
  await link(original, path.join(workspace, 'planted'));
  await assert.rejects(boundary.run('/bin/true', [], { cwd: workspace }), /hard link/i);
});

test('native commands cannot use host HTTP or UNIX sockets or the proxy to bypass retained-data authority', { skip: !enabled }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'frameboard-network-'));
  const dataDir = path.join(root, 'data'); const home = path.join(root, 'native');
  const workspace = path.join(dataDir, 'workspaces', 'card');
  await mkdir(workspace, { recursive: true }); await mkdir(home);
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; res.end('host mutation'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socketPath = path.join(dataDir, 'host.sock');
  const unix = net.createServer((socket) => { calls++; socket.end(); });
  await new Promise((resolve) => unix.listen(socketPath, resolve));
  const boundary = await createNativeBoundary({ dataDir, nativeHome: home });
  t.after(async () => { await boundary.close(); await Promise.all([server, unix].map((server) => new Promise((resolve) => server.close(resolve)))); await rm(root, { recursive: true, force: true }); });
  const result = await boundary.run(process.execPath, ['--input-type=module', '-e', `
    import net from 'node:net'; import http from 'node:http';
    if (process.env.FRAMEBOARD_TEST_SECRET) throw new Error('Application secret inherited');
    async function blocked(options) {
      await new Promise((resolve, reject) => {
        const socket = net.connect(options);
        socket.on('connect', () => { socket.destroy(); reject(new Error('Host service reached')); });
        socket.on('error', resolve);
      });
    }
    await blocked({host:'127.0.0.1',port:${server.address().port}});
    await blocked({path:${JSON.stringify(socketPath)}});
    await new Promise((resolve, reject) => {
      const request = http.request({host:'127.0.0.1',port:8080,method:'CONNECT',path:'127.0.0.1:${server.address().port}'});
      request.on('connect', (res, socket) => { socket.destroy(); reject(new Error('Private proxy target reached')); });
      request.on('error', resolve); request.end();
    });
    console.log('All host mutation routes blocked');
  `], { cwd: workspace, env: { ...process.env, FRAMEBOARD_TEST_SECRET: 'must-not-inherit' } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /All host mutation routes blocked/);
  assert.equal(calls, 0);
});
