// Project Library filenames, read the same way in the browser and on the server.
// A filename is the asset's label, never a filesystem path.
const invalid = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

export function libraryFilename(value) {
  if (typeof value !== 'string') invalid('Name the file.');
  const name = value.normalize('NFC').trim();
  if (!name || name === '.' || name === '..') invalid('Name the file.');
  if (name.length > 255) invalid('File names can be up to 255 characters.');
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) invalid('File names cannot contain slashes or control characters.');
  return name;
}

// A leading dot names the file (".env"), not an extension.
export function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ''];
}

// Create new keeps the extension: logo.png becomes "logo (1).png".
export function availableFilename(name, taken) {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  const [base, extension] = splitExtension(name); const suffix = extension ? `.${extension}` : '';
  let n = 1;
  while (used.has(`${base} (${n})${suffix}`)) n++;
  return `${base} (${n})${suffix}`;
}

// The file holding a name, with the name Create new would use instead.
export function nameConflict(filename, holders) {
  const holder = holders.find((entry) => entry.filename === filename);
  return holder ? { assetId: holder.id, filename, suggested: availableFilename(filename, holders.map((entry) => entry.filename)) } : null;
}

// Only these types are shown inline: images by the browser, text as plain text.
const previewTypes = {
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], avif: ['image', 'image/avif'],
  ...Object.fromEntries(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'srt', 'vtt', 'yaml', 'yml', 'log'].map((extension) => [extension, ['text', 'text/plain; charset=utf-8']])),
};
export function previewType(filename) {
  const found = previewTypes[splitExtension(filename)[1].toLowerCase()];
  return found ? { kind: found[0], type: found[1] } : null;
}
// A written document is UTF-8 text whatever its name; uploads go by extension.
export const assetPreview = ({ kind, filename }) => kind === 'document' ? { kind: 'text', type: 'text/plain; charset=utf-8' } : previewType(filename);
