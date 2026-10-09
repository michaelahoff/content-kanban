// Project Library filenames, read the same way in the browser and on the server.
// A filename is the asset's label, never a filesystem path.
// A selected Library source's identity, such as asset:<id>.
export const sourceKey = (source) => `${source.kind}:${source.id}`;
export function parseSourceKey(key) {
  const [, kind, id] = /^(asset|folder):(.+)$/s.exec(key) ?? [];
  return kind ? { kind, id } : null;
}
const invalid = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

export function libraryFilename(value, noun = 'file') {
  const label = noun === 'folder' ? 'Folder' : 'File';
  if (typeof value !== 'string') invalid(`Name the ${noun}.`);
  const name = value.normalize('NFC').trim();
  if (!name || name === '.' || name === '..') invalid(`Name the ${noun}.`);
  if (name.length > 255) invalid(`${label} names can be up to 255 characters.`);
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) invalid(`${label} names cannot contain slashes or control characters.`);
  return name;
}

// A leading dot names the file (".env"), not an extension.
export function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ''];
}

// Create new keeps the extension: logo.png becomes "logo (1).png". Folder
// names have none: "v1.2" becomes "v1.2 (1)".
export function availableFilename(name, taken, { extension: keepExtension = true } = {}) {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  const [base, extension] = keepExtension ? splitExtension(name) : [name, '']; const suffix = extension ? `.${extension}` : '';
  let n = 1;
  while (used.has(`${base} (${n})${suffix}`)) n++;
  return `${base} (${n})${suffix}`;
}

// The file holding a name in one folder, with the name Create new would use
// instead. A subfolder also holds its name, but cannot be replaced.
export function nameConflict(filename, holders) {
  const holder = holders.find((entry) => entry.filename === filename);
  return holder ? { ...(holder.kind === 'folder' ? {} : { assetId: holder.id }), filename, suggested: availableFilename(filename, holders.map((entry) => entry.filename)) } : null;
}

// Deterministic Library path order, segment by segment: "refs/a.png" sorts
// before "refs.txt", independent of locale.
export function comparePaths(a, b) {
  const left = a.split('/'); const right = b.split('/');
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}

// Full labels for a listing: folders end with "/", e.g. "Thumbnails/References/".
export function libraryPaths({ folders, assets }) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const folderPaths = new Map();
  const pathOf = (id) => {
    if (!id || !byId.has(id)) return '';
    if (!folderPaths.has(id)) folderPaths.set(id, `${pathOf(byId.get(id).parentId)}${byId.get(id).name}/`);
    return folderPaths.get(id);
  };
  for (const folder of folders) pathOf(folder.id);
  return { folders: folderPaths, assets: new Map(assets.map((asset) => [asset.id, pathOf(asset.folderId) + asset.filename])) };
}

// Search matches whole paths, case-insensitively; folders come first.
export function searchLibrary(listing, query) {
  const needle = query.toLocaleLowerCase().trim();
  const paths = libraryPaths(listing);
  return [...listing.folders.map((folder) => ({ kind: 'folder', id: folder.id, path: paths.folders.get(folder.id), item: folder })),
    ...listing.assets.map((asset) => ({ kind: 'asset', id: asset.id, path: paths.assets.get(asset.id), item: asset }))]
    .filter((entry) => entry.path.toLocaleLowerCase().includes(needle));
}

// The subfolders and files holding names in one folder (null: the root).
export const folderHolders = ({ folders, assets }, folderId) => [
  ...folders.filter((folder) => folder.parentId === folderId).map((folder) => ({ kind: 'folder', id: folder.id, filename: folder.name })),
  ...assets.filter((asset) => asset.folderId === folderId).map((asset) => ({ kind: 'asset', id: asset.id, filename: asset.filename })),
];

// Only these types are shown inline: images by the browser, text as plain text.
const previewTypes = {
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], avif: ['image', 'image/avif'],
  ...Object.fromEntries(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'srt', 'vtt', 'yaml', 'yml', 'log'].map((extension) => [extension, ['text', 'text/plain; charset=utf-8']])),
};
export function previewType(filename) {
  const found = previewTypes[splitExtension(filename)[1].toLowerCase()];
  return found ? { kind: found[0], type: found[1] } : null;
}
// A version saved from the document editor is UTF-8 text whatever the file is
// named; uploaded bytes go by extension.
export const assetPreview = (filename, version) => version?.written ? { kind: 'text', type: 'text/plain; charset=utf-8' } : previewType(filename);

// Common general-file formats, recognized by signature parts ([offset, bytes])
// that must all match, for honest descriptions. `media` names a modality no
// card chat target accepts directly. Recognizing a format claims nothing about
// whether a model or tool can interpret it, and never changes a file's route.
const isoBrands = (...brands) => brands.map((brand) => [[4, `ftyp${brand}`]]);
export const fileFormats = {
  pdf: { name: 'PDF', media: 'PDF', signatures: [[[0, '%PDF-']]] },
  zip: { name: 'ZIP archive', signatures: [[[0, 'PK\x03\x04']]] },
  gzip: { name: 'gzip archive', signatures: [[[0, '\x1f\x8b']]] },
  '7z': { name: '7z archive', signatures: [[[0, '7z\xbc\xaf\x27\x1c']]] },
  rar: { name: 'RAR archive', signatures: [[[0, 'Rar!\x1a\x07']]] },
  tar: { name: 'tar archive', signatures: [[[257, 'ustar']]] },
  wav: { name: 'WAV audio', media: 'audio', signatures: [[[0, 'RIFF'], [8, 'WAVE']]] },
  mp3: { name: 'MP3 audio', media: 'audio', signatures: [[[0, 'ID3']]] },
  flac: { name: 'FLAC audio', media: 'audio', signatures: [[[0, 'fLaC']]] },
  m4a: { name: 'M4A audio', media: 'audio', signatures: isoBrands('M4A ') },
  ogg: { name: 'Ogg media', media: 'audio or video', signatures: [[[0, 'OggS']]] },
  mp4: { name: 'MP4 video', media: 'video', signatures: isoBrands('isom', 'iso2', 'iso5', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash') },
  mov: { name: 'QuickTime video', media: 'video', signatures: isoBrands('qt  ') },
  matroska: { name: 'Matroska video', media: 'video', signatures: [[[0, '\x1a\x45\xdf\xa3']]] },
  heif: { name: 'HEIF image', signatures: isoBrands('heic', 'heix', 'mif1', 'msf1') },
  woff2: { name: 'WOFF2 font', signatures: [[[0, 'wOF2']]] },
  woff: { name: 'WOFF font', signatures: [[[0, 'wOFF']]] },
  otf: { name: 'OpenType font', signatures: [[[0, 'OTTO']]] },
  ttf: { name: 'TrueType font', signatures: [[[0, '\x00\x01\x00\x00']]] },
};
// Signatures reach at most this far into a file.
export const formatSampleBytes = 512;
const matches = (bytes, [offset, magic]) => offset + magic.length <= bytes.length && [...magic].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
export function fileFormat(bytes) {
  return Object.keys(fileFormats).find((format) => fileFormats[format].signatures.some((parts) => parts.every((part) => matches(bytes, part)))) ?? null;
}

// How a selected file reaches its target, as previews and history describe it.
// A workspace copy is only made available to Codex's tools; a document is a
// PDF sent to Claude as its own content block.
export function deliveryDescription(entry) {
  if (entry.method === 'text') return 'full text inline';
  if (entry.method === 'image') return 'native image';
  if (entry.method === 'document') return 'PDF · native Claude document';
  const name = entry.format === 'text' ? 'large text' : fileFormats[entry.format]?.name ?? (entry.format ? entry.format.toUpperCase() : null);
  return `${name ? `${name} · ` : ''}workspace copy for Codex tools`;
}
// Every source that selected a file, as previews and history show it: the
// file itself, or a folder (by its captured path) that contained it.
export const selectionPaths = (sources) => sources.map((source) => source.kind === 'folder'
  ? `in ${source.folderPath ? `selected folder ${source.folderPath}` : 'a selected folder'} as ${source.relativePath}` : 'selected directly');
// A frozen selection in order, each folder with how many files it contributed.
export function selectionSummary(selections, files) {
  return selections.map((selection) => {
    if (selection.kind !== 'folder') return selection.path;
    const count = files.filter((file) => file.sources.some((source) => source.kind === 'folder' && source.id === selection.id)).length;
    return `${selection.path} · ${count ? `${count} file${count === 1 ? '' : 's'}` : 'no files'}`;
  });
}
