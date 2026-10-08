// The card editor dialog: text fields, images, YouTube lookup, and copying.
import { createTrifectaItem } from './trifecta.js';
import { $, escape, icon, button, iconButton, imageURL, wordCount, lastEditedMarkup, toast } from './ui.js';
import { state, locateCard, cardChanged, flushCards, onCardFieldsChange, beginCardEditing, endCardEditing } from './state.js';
import { renderBoard, renderStatus } from './board.js';
import { request } from './api.js';
import { templates, fieldInputId } from './card-template.js';
import { mountChat, unmountChat } from './chat.js';

const cardDialog = $('#card-dialog');
let lastCardTrigger;
onCardFieldsChange((card, keys) => {
  renderBoard();
  if (state.cardId !== card.id || !cardDialog.open) return;
  if (keys.some((key) => ['images', 'imageRoles'].includes(key))) renderImages();
  if (keys.includes('placement')) $('#card-lane').value = card.stageId;
  for (const key of keys) {
    const input = $(`#${fieldInputId(key)}`);
    if (input) input.value = key === 'title' ? card.title : card.fields[key];
    const field = templates[card.template].fields.find((field) => field.key === key);
    if (field?.countWords) $(`#${key}-count`).textContent = `${wordCount(card.fields[key]).toLocaleString()} words`;
    if (field?.control === 'url') $(`#${fieldInputId(key)}-link`).innerHTML = field.youtube ? originalVideoMarkup(card) : videoLinkMarkup(card.fields[key], field.videoLabel || field.label);
  }
});

export async function copyText(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied.`);
  } catch {
    toast('Clipboard access was blocked. Allow clipboard access and try again.');
  }
}
export async function copyTrifecta(target) {
  const { card } = locateCard();
  target.disabled = true;
  target.setAttribute('aria-busy', 'true');
  try {
    if (!navigator.clipboard?.write || !window.ClipboardItem) throw new Error('This browser does not support copying images. Open the app in a current browser on localhost or HTTPS.');
    toast('Preparing Trifecta…');
    await navigator.clipboard.write([createTrifectaItem(card)]);
    toast('Trifecta copied as one image, with a text version. Paste into your chat.');
  } catch (error) {
    toast(`Trifecta was not copied. ${error.name === 'NotAllowedError' ? 'Allow clipboard access, keep this page focused, and try again.' : error.message}`);
  } finally {
    target.disabled = false;
    target.removeAttribute('aria-busy');
  }
}
export function videoLinkMarkup(value, label) {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `<a class="video-link" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escape(label)} in a new tab">Open video ${icon('external')}</a>`;
    }
  } catch { /* Keep unfinished URLs editable and saved. */ }
  return '<span class="url-hint">Enter a full http:// or https:// URL to open it.</span>';
}
function editorField(field, card) {
  const inputId = fieldInputId(field.key);
  const value = card.fields[field.key] || '';
  const label = `<label for="${inputId}">${escape(field.label)}</label>`;
  const attributes = `id="${inputId}" maxlength="${field.max}" placeholder="${escape(field.placeholder || '')}"`;
  const input = field.control === 'textarea'
    ? `<textarea ${attributes}>${escape(value)}</textarea>`
    : `<input class="form-input" ${attributes} type="${field.control || 'text'}" value="${escape(value)}" autocomplete="off"${field.control === 'url' ? ' autocapitalize="off" spellcheck="false"' : ''}>`;
  const link = field.control === 'url' ? `<div class="video-link-row" id="${inputId}-link">${field.youtube ? originalVideoMarkup(card) : videoLinkMarkup(value, field.videoLabel || field.label)}</div>` : '';
  if (field.placement === 'header') return `<section class="original-video">${label}<div class="original-video-row">${input}${link}</div></section>`;
  const hint = field.countWords ? `<span id="${escape(field.key)}-count">${wordCount(value).toLocaleString()} words</span>` : field.hint ? `<span>${escape(field.hint)}</span>` : '';
  const tools = field.copy ? `<div class="field-tools">${hint}${button('copy-field', `Copy ${escape(field.label.toLowerCase())}`, null, 'button small secondary', `data-field="${escape(field.key)}"`)}</div>` : hint;
  return `<section class="writing-section ${field.control === 'url' ? 'video-url' : field.section || fieldInputId(field.key).slice(5)}-section"><div class="field-heading">${label}${tools}</div>${input}${link}</section>`;
}
const youtubePattern = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\//i;
export function originalVideoMarkup(card) {
  const value = card.fields.originalVideoUrl.trim();
  const fetchButton = youtubePattern.test(value) ? button('fetch-youtube', 'Get title & thumbnail', 'download', 'button small primary') : '';
  return `${fetchButton}${videoLinkMarkup(value, 'original video')}`;
}
export function openCard(targetId) {
  const found = locateCard(targetId);
  if (!found) return;
  unmountChat();
  if (state.cardId && state.cardId !== targetId) endCardEditing(state.cardId);
  beginCardEditing(targetId);
  state.cardId = targetId;
  lastCardTrigger = document.activeElement;
  const { card, lane, project: p } = found;
  const template = templates[card.template];
  cardDialog.innerHTML = `<div class="editor-header"><div class="editor-breadcrumb">${icon('board')}<span>${escape(p.name)}</span>${icon('chevron')}<label class="sr-only" for="card-lane">Move card to lane</label><select id="card-lane">${p.lanes.map((item) => `<option value="${item.id}" ${item.id === lane.id ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select></div><div class="editor-header-right">${button('undo-move', 'Undo last move', 'undo', 'button small secondary', 'data-undo-move="card" disabled')}<span class="save-status" data-save-status></span>${iconButton('close-card', 'Close card editor', 'close')}</div></div>
    <div id="editor-save-error" class="error-banner" role="alert" hidden></div>
    ${template.fields.filter((field) => field.placement === 'header').map((field) => editorField(field, card)).join('')}
    <div class="editor-title"><label class="sr-only" for="card-title">${escape(template.title.label)}</label><input id="card-title" placeholder="Untitled card" maxlength="${template.title.max}" value="${escape(card.title)}" autocomplete="off"><span class="editor-title-hint">Give your idea a name</span></div>
    <div class="editor-content"><div class="writing-panel">
      ${template.fields.filter((field) => field.placement !== 'header').map((field) => editorField(field, card)).join('')}
    </div>
    <aside class="images-panel" aria-label="Card images"><div class="field-heading"><h2>Images</h2><span id="image-count"></span></div><div id="card-images"></div><label class="image-drop" id="image-drop">${icon('upload')}<strong>Add some inspiration</strong><span>Drop images here or <u>browse files</u></span><span class="paste-shortcut">You can also paste anywhere in this card</span><input id="image-files" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple aria-label="Upload images"></label><p class="image-note">PNG, JPG, WebP, GIF or AVIF · up to 20 MB each</p><p id="upload-status" class="upload-status" role="status"></p></aside></div>
    <div class="editor-footer">${button('delete-card', 'Delete card', 'trash', 'text-button danger')}${button('copy-trifecta', 'Trifecta copy', 'text', 'button secondary')}<span class="edited-at" data-edited-card="${card.id}">${lastEditedMarkup(card)}</span>${button('close-card', 'Done', 'check', 'button primary')}</div>`;
  renderImages();
  renderStatus();
  mountChat(targetId);
  if (!card.title) $(card.fields.originalVideoUrl ? '#card-title' : '#card-original-video-url').focus();
}
export function renderImages() {
  const found = locateCard();
  if (!found || !$('#card-images')) return;
  const { card } = found;
  $('#image-count').textContent = `${card.images.length} ${card.images.length === 1 ? 'image' : 'images'}`;
  const { cover: coverImageId, original: originalImageId, inspiration: inspirationImageId } = card.imageRoles;
  const cover = card.images.find((image) => image.id === coverImageId);
  $('#card-images').innerHTML = `${cover ? `<div class="display-image"><button data-action="preview-image" data-id="${cover.id}" aria-label="Preview display image"><img src="${imageURL(cover.id)}" alt="${escape(cover.name)}"></button><span class="display-badge">${icon('star')} Display image</span></div>` : `<div class="display-placeholder">${icon('image')}<span>Your images go here</span><small>The display image appears on your board.</small></div>`}
    ${card.images.length ? `<p class="gallery-heading">Choose the display, original, and inspiration images for this card.</p><div class="image-gallery">${card.images.map((item) => `<div class="image-tile ${item.id === coverImageId ? 'is-display' : ''}"><button class="thumbnail" data-action="preview-image" data-id="${item.id}" aria-label="Preview ${escape(item.name)}"><img src="${imageURL(item.id)}" alt="${escape(item.name)}" loading="lazy"></button>${iconButton('remove-image', `Remove ${item.name}`, 'close', `data-id="${item.id}"`)}<div class="image-flags"><button class="set-display" data-action="set-display" data-id="${item.id}" aria-pressed="${item.id === coverImageId}">${icon(item.id === coverImageId ? 'check' : 'star')}${item.id === coverImageId ? 'Display image' : 'Set as display'}</button><button class="set-image-role ${item.id === originalImageId ? 'selected' : ''}" data-action="set-image-role" data-role="original" data-id="${item.id}" aria-pressed="${item.id === originalImageId}">${item.id === originalImageId ? '✓ ' : ''}Original</button><button class="set-image-role ${item.id === inspirationImageId ? 'selected' : ''}" data-action="set-image-role" data-role="inspiration" data-id="${item.id}" aria-pressed="${item.id === inspirationImageId}">${item.id === inspirationImageId ? '✓ ' : ''}Inspiration</button></div></div>`).join('')}</div>` : ''}`;
}
export function closeCard() {
  unmountChat();
  if (state.cardId) endCardEditing(state.cardId);
  cardDialog.close();
}
cardDialog.addEventListener('cancel', () => { if (state.cardId) endCardEditing(state.cardId); });
cardDialog.addEventListener('close', () => {
  // The close event arrives as a separate task, so ignore it if a card was reopened first.
  if (cardDialog.open) return;
  unmountChat();
  if (state.cardId) endCardEditing(state.cardId);
  state.cardId = null;
  renderBoard();
  flushCards();
  if (lastCardTrigger?.isConnected) lastCardTrigger.focus();
  else $('[data-action="add-card"]')?.focus();
});
export async function fetchYoutube(target) {
  const targetCardId = state.cardId;
  const { card } = locateCard(targetCardId);
  const url = card.fields.originalVideoUrl.trim();
  target.disabled = true;
  target.setAttribute('aria-busy', 'true');
  target.lastChild.textContent = 'Fetching…';
  state.uploads++;
  renderStatus();
  try {
    const result = await request('/api/youtube', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const found = locateCard(targetCardId);
    if (!found) return;
    const current = found.card;
    if (current.fields.originalVideoUrl.trim() !== url) return toast('The Original URL changed while fetching. Fetch again for the new link.');
    // Replace the thumbnail from an earlier fetch instead of piling up copies.
    const roles = current.imageRoles;
    const previous = roles.original;
    if (previous && current.images.find((image) => image.id === previous)?.name.endsWith(' thumbnail.jpg')) {
      current.images = current.images.filter((image) => image.id !== previous);
      if (roles.cover === previous) roles.cover = null;
    }
    if (current.images.length >= 200) throw new Error('A card can hold up to 200 images.');
    current.images.unshift(result.image);
    roles.original = result.image.id;
    roles.cover ||= result.image.id;
    current.fields.originalVideoTitle = result.title;
    if (!current.title.trim()) current.title = result.title;
    cardChanged(current);
    if (state.cardId === targetCardId) {
      $('#card-title').value = current.title;
      $('#card-original-video-title').value = current.fields.originalVideoTitle;
      renderImages();
    }
    renderBoard();
    toast('Title and thumbnail added.');
  } catch (error) {
    toast(error.message);
  } finally {
    state.uploads--;
    renderStatus();
    if (state.cardId === targetCardId && $('#card-original-video-url-link')) $('#card-original-video-url-link').innerHTML = originalVideoMarkup(locateCard(targetCardId).card);
    flushCards();
  }
}
export async function addImages(files, targetCardId) {
  const candidates = [...files];
  if (!candidates.length) return;
  state.uploads++;
  renderStatus();
  if ($('#upload-status')) $('#upload-status').textContent = 'Uploading images…';
  let added = 0;
  const errors = [];
  try {
    for (const file of candidates) {
      if (!locateCard(targetCardId)) break;
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'].includes(file.type)) { errors.push(`${file.name || 'File'}: unsupported format.`); continue; }
      if (file.size > 20 * 1024 * 1024) { errors.push(`${file.name}: exceeds 20 MB.`); continue; }
      if (locateCard(targetCardId).card.images.length >= 200) { errors.push('A card can hold up to 200 images.'); break; }
      try {
        const result = await request('/api/images', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
        const found = locateCard(targetCardId);
        if (!found) break;
        found.card.images.push({ id: result.id, name: (file.name || 'Pasted image').slice(0, 500) });
        found.card.imageRoles.cover ||= result.id;
        added++;
        cardChanged(found.card);
        if (state.cardId === targetCardId) renderImages();
        renderBoard();
      } catch (error) { errors.push(error.message); }
    }
  } finally {
    state.uploads--;
    renderStatus();
    const message = errors.length ? `${added ? `${added} added. ` : ''}${errors.join(' ')}` : `${added} ${added === 1 ? 'image' : 'images'} added.`;
    if (state.cardId === targetCardId && $('#upload-status')) $('#upload-status').textContent = message;
    toast(message);
    flushCards();
  }
}
