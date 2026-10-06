const escape = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const htmlText = (text) => escape(text).replace(/\n/g, '<br>');
const maxHeight = 16000;
const lineHeight = 38;

function wrapLines(context, text, width) {
  const lines = [];
  const addLine = (line) => {
    lines.push(line);
    if (lines.length * lineHeight > maxHeight) throw new Error('This card has too much text for one image. Shorten the prompt, titles, or intro and try again.');
  };
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/u)) {
      const next = line ? `${line} ${word}` : word;
      if (context.measureText(next).width <= width) { line = next; continue; }
      if (line) addLine(line);
      line = '';
      // Even an unbroken URL or a line without spaces must fit on the image.
      for (const character of word) {
        if (context.measureText(line + character).width > width && line) {
          addLine(line);
          line = '';
        }
        line += character;
      }
    }
    addLine(line);
  }
  return lines;
}

function imageSheet(prompt, titles, intro, images) {
  const canvas = document.createElement('canvas');
  const width = 1600;
  const padding = 64;
  const gap = 40;
  const contentWidth = width - 2 * padding;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Your browser could not prepare the Trifecta image.');
  context.font = '26px sans-serif';
  const blocks = [];
  let y = padding;
  const textBlock = (label, value) => {
    const lines = wrapLines(context, value || '(empty)', contentWidth);
    blocks.push({ label, lines, y });
    y += 44 + lines.length * lineHeight + gap;
  };
  textBlock('PROMPT', prompt);
  textBlock('TITLES', titles.length ? titles.map((title) => `• ${title}`).join('\n') : '(none)');
  const imageWidth = (contentWidth - gap * (images.length - 1)) / Math.max(1, images.length);
  let imageHeight = 0;
  images.forEach((image, index) => {
    const scale = Math.min(1, imageWidth / image.bitmap.width, 1800 / image.bitmap.height);
    const w = Math.max(1, Math.round(image.bitmap.width * scale));
    const h = Math.max(1, Math.round(image.bitmap.height * scale));
    blocks.push({ label: image.label.toUpperCase(), bitmap: image.bitmap, x: padding + index * (imageWidth + gap), y, w, h });
    imageHeight = Math.max(imageHeight, h);
  });
  if (images.length) y += 44 + imageHeight + gap;
  textBlock('INTRO', intro);
  const height = y - gap + padding;
  if (height > maxHeight) throw new Error('This card has too much text for one image. Shorten the prompt, titles, or intro and try again.');
  canvas.width = width;
  canvas.height = height;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.textBaseline = 'top';
  for (const block of blocks) {
    const x = block.x ?? padding;
    context.fillStyle = '#515864';
    context.font = 'bold 22px sans-serif';
    context.fillText(block.label, x, block.y);
    if (block.bitmap) {
      context.drawImage(block.bitmap, x, block.y + 44, block.w, block.h);
    } else {
      context.fillStyle = '#141820';
      context.font = '26px sans-serif';
      block.lines.forEach((line, index) => context.fillText(line, x, block.y + 44 + index * lineHeight));
    }
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error('Your browser could not prepare the Trifecta image.'));
  }, 'image/png'));
}

function dataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the Trifecta image.'));
    reader.readAsDataURL(blob);
  });
}

// Each MIME type represents the same complete packet. Image-first chat inputs
// can consume the PNG alone without losing the prompt, titles, or intro.
export function createTrifectaItem(card) {
  const { prompt, intro, titleOptions, originalVideoTitle } = card.fields;
  const titles = [card.title, ...titleOptions.split('\n'), originalVideoTitle]
    .map((title) => title.trim()).filter(Boolean);
  const selected = [['Original', card.imageRoles.original], ['Inspiration', card.imageRoles.inspiration]]
    .filter(([, id]) => id).map(([label, id]) => ({ label, id }));
  const plain = ['PROMPT', prompt || '(empty)', '\nTITLES', titles.join('\n') || '(none)',
    ...(selected.length ? ['\nIMAGES', 'The attached Trifecta image contains the labeled original and inspiration selections.'] : []),
    '\nINTRO', intro || '(empty)'].join('\n');
  const images = (async () => {
    const loaded = [];
    try {
      // Sequential loading also guarantees all decoded images can be released
      // if a later fetch/decode fails.
      for (const item of selected) {
        const response = await fetch(`/images/${encodeURIComponent(item.id)}`);
        if (!response.ok) throw new Error(`Could not load the ${item.label.toLowerCase()} image. Try again.`);
        const blob = await response.blob();
        let bitmap;
        try { bitmap = await createImageBitmap(blob); }
        catch { throw new Error(`Could not read the ${item.label.toLowerCase()} image. Try uploading it again.`); }
        loaded.push({ ...item, blob, bitmap });
      }
      return loaded;
    } catch (error) {
      loaded.forEach(({ bitmap }) => bitmap.close());
      throw error;
    }
  })();
  const png = images.then(async (loaded) => {
    try { return await imageSheet(prompt, titles, intro, loaded); }
    finally { loaded.forEach(({ bitmap }) => bitmap.close()); }
  });
  const html = images.then(async (loaded) => {
    const figures = await Promise.all(loaded.map(async ({ label, blob }) =>
      `<figure><figcaption>${label}</figcaption><img src="${await dataURL(blob)}" alt="${label}"></figure>`));
    return new Blob([
      `<h2>Prompt</h2><p>${htmlText(prompt)}</p><h2>Titles</h2><ul>${titles.map((title) => `<li>${escape(title)}</li>`).join('')}</ul>${figures.join('')}<h2>Intro</h2><p>${htmlText(intro)}</p>`,
    ], { type: 'text/html' });
  });
  // Clipboard writes can be denied before the browser awaits the data. Keep
  // those preparation promises handled while preserving their rejection.
  png.catch(() => {});
  html.catch(() => {});
  // Pass promises directly so clipboard.write can run in the click gesture,
  // including on browsers that end user activation at the first await.
  return new ClipboardItem({
    'image/png': png,
    'text/html': html,
    'text/plain': new Blob([plain], { type: 'text/plain' }),
  });
}
