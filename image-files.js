// The immutable hashed image store and the only paths by which bytes enter it.
// Gallery uploads and chat image versions share data/images/; the database
// records each version's hash, and every read for import, reference or serving
// checks it. Nothing here adopts an image or assigns a role.
import { open, realpath, writeFile, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const maxImageBytes = 20 * 1024 * 1024;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function imageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))) return 'avif';
  return null;
}

// Reads one regular, singly linked file without following a final symlink.
export async function readRegularFile(filename) {
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code === 'ELOOP') fail(403, 'Image files cannot be symbolic links.');
    if (error.code === 'ENOENT') fail(404, 'The image file is missing.');
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) fail(400, 'Images must be regular files.');
    if (info.size > maxImageBytes) fail(413, 'Images must be under 20 MB.');
    const buffer = Buffer.alloc(maxImageBytes + 1);
    let length = 0;
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > maxImageBytes) fail(413, 'Images must be under 20 MB.');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export async function within(root, filename) {
  const base = await realpath(root).catch(() => null);
  const resolved = await realpath(filename).catch(() => null);
  return Boolean(base && resolved && resolved.startsWith(base + path.sep));
}

// Bytes from a native imageGeneration item. Returned base64 is authoritative;
// a provider-owned saved file must agree with it, and is used alone only when
// the notification omitted media. A path outside Codex generated images or a
// linked file is never read; it cannot replace or reject returned bytes.
export async function nativeImageBytes({ result, savedPath }, nativeRoot) {
  let bytes = typeof result === 'string' && result ? Buffer.from(result, 'base64') : null;
  if (savedPath) {
    const root = nativeRoot && path.join(nativeRoot, 'generated_images');
    const outside = () => fail(422, 'Codex reported a saved image outside its generated images directory.');
    let saved;
    try {
      if (!root || !path.isAbsolute(savedPath) || !path.resolve(savedPath).startsWith(path.resolve(root) + path.sep)) outside();
      saved = await readRegularFile(savedPath);
      if (!(await within(root, savedPath))) outside();
    } catch (error) { if (!bytes || ![403, 404, 422].includes(error.status)) throw error; saved = null; }
    if (saved && bytes && !saved.equals(bytes)) fail(422, 'The native saved image differs from the returned bytes. It is treated as damaged.');
    bytes ??= saved;
  }
  if (!bytes) fail(422, 'Codex reported a completed image without retrievable bytes.');
  return bytes;
}

// Validates and writes one immutable version; the caller records it.
export async function storeImage(imagesDir, bytes) {
  if (bytes.length > maxImageBytes) fail(413, 'Images must be under 20 MB.');
  const format = imageFormat(bytes);
  if (!format) fail(422, 'This file is not a supported image.');
  const id = `${randomUUID()}.${format}`;
  await writeFile(path.join(imagesDir, id), bytes, { flag: 'wx', mode: 0o444 });
  return { id, hash: sha256(bytes), size: bytes.length, format };
}

// Reads a stored version and refuses bytes that differ from its recorded hash.
export async function verifiedImage(imagesDir, id, hash) {
  const bytes = await readFile(path.join(imagesDir, id));
  if (hash && sha256(bytes) !== hash) fail(409, 'This image version is damaged. Its bytes differ from the recorded hash.');
  return bytes;
}
