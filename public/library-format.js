// Project Library filenames, read the same way in the browser and on the server.
// A filename is the asset's label, never a filesystem path.
// A selected Library source's identity, such as asset:<id>.
export const sourceKey = (source) => `${source.kind}:${source.id}`;
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

// How a selected file reaches its target, as previews and history describe it.
// A workspace copy is only made available to Codex's tools: naming its format
// claims nothing about whether a model or tool can interpret it.
const formatNames = {
  text: 'large text', pdf: 'PDF', zip: 'ZIP archive', gzip: 'gzip archive', '7z': '7z archive', rar: 'RAR archive',
  wav: 'WAV audio', mp3: 'MP3 audio', flac: 'FLAC audio', ogg: 'Ogg media', m4a: 'M4A audio', mov: 'QuickTime video', mp4: 'MP4 video',
  matroska: 'Matroska video', woff2: 'WOFF2 font', woff: 'WOFF font', otf: 'OpenType font', ttf: 'TrueType font',
};
export function deliveryDescription(entry) {
  if (entry.method === 'text') return 'full text inline';
  if (entry.method === 'image') return 'native image';
  const name = formatNames[entry.format] ?? (entry.format ? entry.format.toUpperCase() : null);
  return `${name ? `${name} · ` : ''}workspace copy for Codex tools`;
}
