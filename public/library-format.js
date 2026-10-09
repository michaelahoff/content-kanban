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

// Create new keeps the extension: logo.png becomes "logo (1).png".
export function availableFilename(name, taken) {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name; const extension = dot > 0 ? name.slice(dot) : '';
  let n = 1;
  while (used.has(`${base} (${n})${extension}`)) n++;
  return `${base} (${n})${extension}`;
}

// Only these types are shown inline: images by the browser, text as plain text.
const previewTypes = {
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'], webp: ['image', 'image/webp'], avif: ['image', 'image/avif'],
  ...Object.fromEntries(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'srt', 'vtt', 'yaml', 'yml', 'log'].map((extension) => [extension, ['text', 'text/plain; charset=utf-8']])),
};
export function previewType(filename) {
  const dot = filename.lastIndexOf('.');
  const found = dot > 0 && previewTypes[filename.slice(dot + 1).toLowerCase()];
  return found ? { kind: found[0], type: found[1] } : null;
}
