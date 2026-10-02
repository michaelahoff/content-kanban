import { createTrifectaItem } from './trifecta.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const escape = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  board: '<rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="10" rx="2"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6Z M13 6l5 5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
  monitor: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M12 16v5M8 21h8"/>',
  text: '<path d="M4 5h16M4 10h16M4 15h10M4 20h7"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  grip: '<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 15v6h16v-6"/>',
  external: '<path d="M14 3h7v7M21 3 11 13M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.board}</svg>`;
const button = (action, label, symbol, cls = '', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${label}</button>`;
const iconButton = (action, label, symbol, attrs = '') => button(action, '', symbol, 'icon-button', `aria-label="${escape(label)}" title="${escape(label)}" ${attrs}`);
const id = () => crypto.randomUUID();
const imageURL = (imageId) => `/images/${encodeURIComponent(imageId)}`;
const palette = ['lavender', 'blue', 'amber', 'green', 'pink', 'gray', 'teal', 'cyan', 'orange', 'red', 'purple', 'lime'];
const editedDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const app = $('#app');
const cardDialog = $('#card-dialog');
const formDialog = $('#form-dialog');
const imageDialog = $('#image-dialog');
let board;
let revision;
let projectId;
let cardId = null;
let pasteLaneId;
let query = '';
let dirty = false;
let saving = false;
let saveError = '';
let saveTimer;
let uploads = 0;
let draggedId;
let toastTimer;
let lastCardTrigger;

function project() { return board.projects.find((item) => item.id === projectId); }
function locateCard(targetId = cardId) {
  for (const p of board.projects) for (const lane of p.lanes) {
    const card = lane.cards.find((item) => item.id === targetId);
    if (card) return { card, lane, project: p };
  }
  return null;
}
function cardCount(p) { return p.lanes.reduce((sum, lane) => sum + lane.cards.length, 0); }
function wordCount(text) { return text.trim() ? text.trim().split(/\s+/u).length : 0; }
async function copyText(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied.`);
  } catch {
    toast('Clipboard access was blocked. Allow clipboard access and try again.');
  }
}
async function copyTrifecta(target) {
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
function videoLinkMarkup(value, label) {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `<a class="video-link" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escape(label)} in a new tab">Open video ${icon('external')}</a>`;
    }
  } catch { /* Keep unfinished URLs editable and saved. */ }
  return '<span class="url-hint">Enter a full http:// or https:// URL to open it.</span>';
}
function videoUrlField(inputId, label, value = '') {
  return `<section class="writing-section video-url-section"><div class="field-heading"><label for="${inputId}">${label} URL</label></div><input class="form-input" id="${inputId}" type="url" maxlength="4096" placeholder="https://…" value="${escape(value)}" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="video-link-row" id="${inputId}-link">${videoLinkMarkup(value, label.toLowerCase())}</div></section>`;
}
const youtubePattern = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)\//i;
function originalVideoMarkup(card) {
  const value = (card.originalVideoUrl || '').trim();
  const fetchButton = youtubePattern.test(value) ? button('fetch-youtube', 'Get title & thumbnail', 'download', 'button small primary') : '';
  return `${fetchButton}${videoLinkMarkup(value, 'original video')}`;
}
function lastEditedMarkup(card) {
  if (!card.updatedAt) return `${icon('clock')}<span>Last edit not recorded</span>`;
  const date = new Date(card.updatedAt);
  const fullDate = date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' });
  return `${icon('clock')}<time datetime="${escape(card.updatedAt)}" title="${escape(fullDate)}">Edited ${escape(editedDateFormat.format(date))}</time>`;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200);
}
async function request(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.');
  return result;
}
function changed(editedCard) {
  if (editedCard) {
    editedCard.updatedAt = new Date().toISOString();
    document.querySelectorAll('[data-edited-card]').forEach((node) => {
      if (node.dataset.editedCard === editedCard.id) node.innerHTML = lastEditedMarkup(editedCard);
    });
  }
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 450);
  renderStatus();
}
async function save() {
  if (saving || !dirty) return;
  saving = true;
  dirty = false;
  saveError = '';
  const snapshot = JSON.stringify({ board, revision });
  renderStatus();
  try {
    const result = await request('/api/board', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: snapshot });
    revision = result.revision;
  } catch (error) {
    dirty = true;
    saveError = error.message;
  } finally {
    saving = false;
    renderStatus();
    if (dirty && !saveError) save();
  }
}
function renderStatus() {
  const label = saveError ? 'Changes not saved' : uploads ? 'Uploading images…' : saving || dirty ? 'Saving…' : 'All changes saved';
  document.querySelectorAll('[data-save-status]').forEach((node) => {
    node.innerHTML = `${icon(saveError ? 'close' : 'check')}<span>${label}</span>`;
    node.classList.toggle('save-error', !!saveError);
  });
  const banner = $('#save-error');
  if (banner) {
    banner.hidden = !saveError;
    banner.innerHTML = `<span>${escape(saveError)}</span>${button('retry-save', 'Retry save', null, 'button small')}`;
  }
  const editorError = $('#editor-save-error');
  if (editorError) {
    editorError.hidden = !saveError;
    editorError.innerHTML = `<span>${escape(saveError)}</span>${button('retry-save', 'Retry save', null, 'button small')}`;
  }
}
function renderApp() {
  const p = project();
  document.title = `${p?.name || 'Workspace'} · Frameboard`;
  app.innerHTML = `
    <aside class="sidebar" aria-label="Projects">
      <a class="brand" href="/" aria-label="Frameboard home"><span class="brand-mark">${icon('board')}</span>Frameboard<span class="brand-period">.</span></a>
      <div class="workspace-label">PERSONAL WORKSPACE</div>
      <div class="sidebar-section"><span>Projects</span>${iconButton('add-project', 'Add project', 'plus')}</div>
      <nav class="project-list">${board.projects.map((item) => `<button class="project-link ${item.id === projectId ? 'active' : ''}" data-action="switch-project" data-id="${item.id}" ${item.id === projectId ? 'aria-current="page"' : ''}>${icon('board')}<span>${escape(item.name)}</span><span class="project-count">${cardCount(item)}</span></button>`).join('')}</nav>
      ${button('add-project', 'New project', 'plus', 'new-project')}
      <div class="sidebar-bottom"><div class="local-label"><span class="online-dot"></span>Local workspace</div><p>Just you and your ideas.<br>Saved on this computer.</p><div class="workspace-owner"><span class="avatar">Y</span><div><strong>Your workspace</strong><span>No account needed</span></div>${icon('monitor')}</div></div>
    </aside>
    <main class="main">
      <div class="topbar"><div class="breadcrumbs">${iconButton('toggle-sidebar', 'Toggle projects', 'menu')}<span>Workspace</span>${icon('chevron')}<strong>Board</strong></div><div class="save-status" data-save-status></div></div>
      <div id="save-error" class="error-banner" role="alert" hidden></div>
      ${p ? `<header class="board-header"><div><div class="eyebrow">A LITTLE SPACE FOR BIG IDEAS</div><div class="heading-row"><h1>${escape(p.name)}</h1>${iconButton('edit-project', 'Project settings', 'more')}</div><p class="board-subtitle">Capture the idea. Find the words. Make it happen.</p></div><div class="header-actions">${button('set-project-prompt', 'Set prompt', 'text', 'button secondary')}${button('add-lane', 'Add lane', 'plus', 'button secondary')}${button('add-card', 'New card', 'plus', 'button primary', p.lanes.length ? '' : 'disabled')}</div></header>
      <div class="board-toolbar"><div class="board-tab">${icon('board')} Board <span id="total-count">${cardCount(p)}</span></div><div class="board-tools"><span class="paste-hint">${icon('image')} Paste an image to start a card</span><label class="search">${icon('search')}<input id="search" type="search" placeholder="Find a card…" aria-label="Find a card" value="${escape(query)}"></label></div></div>
      <div id="board" class="board" aria-label="${escape(p.name)} kanban board"></div>
      <footer class="board-footer"><span>${icon('grip')} Drag cards to move them between lanes</span><span>Your next idea belongs here.</span></footer>` : `<div class="no-projects"><span class="empty-symbol">${icon('board')}</span><h1>Room for your ideas.</h1><p>Create a project and make it your own.</p>${button('add-project', 'Create a project', 'plus', 'button primary')}</div>`}
    </main>`;
  renderBoard();
  renderStatus();
}
function cardMarkup(card) {
  const words = wordCount(`${card.titleOptions || ''} ${card.intro} ${card.script}`);
  return `<article class="card" draggable="true" data-card="${card.id}">
    <button class="card-open" data-action="open-card" data-id="${card.id}" aria-label="Open ${escape(card.title || 'Untitled card')}">
      ${card.coverImageId ? `<div class="card-image"><img src="${imageURL(card.coverImageId)}" alt="" loading="lazy"><span class="card-open-label">Open card ${icon('arrow')}</span></div>` : `<div class="card-image no-image">${icon('image')}<span>Add a little inspiration</span><span class="card-open-label">Open card ${icon('arrow')}</span></div>`}
      <div class="card-body"><h3>${escape(card.title || 'Untitled card')}</h3>${card.intro.trim() ? `<p>${escape(card.intro)}</p>` : ''}<div class="card-meta"><span>${icon('text')}${words ? `${words.toLocaleString()} words` : 'Ready for your words'}</span><span>${icon('image')}${card.images.length}</span></div><span class="edited-at" data-edited-card="${card.id}">${lastEditedMarkup(card)}</span></div>
    </button></article>`;
}
function renderBoard() {
  const container = $('#board');
  const p = project();
  if (!container || !p) return;
  const search = query.toLocaleLowerCase().trim();
  container.innerHTML = p.lanes.map((lane) => {
    const cards = lane.cards.filter((card) => `${card.title}\n${card.originalVideoUrl || ''}\n${card.titleOptions || ''}\n${card.intro}\n${card.script}\n${card.originalVideoTitle || ''}\n${card.publishedVideoUrl || ''}`.toLocaleLowerCase().includes(search));
    return `<section class="lane" data-lane="${lane.id}" tabindex="0" aria-label="${escape(lane.name)} lane; paste images here">
      <div class="lane-heading"><span class="lane-dot ${lane.color}"></span><h2>${escape(lane.name)}</h2><span class="lane-count">${search ? `${cards.length}/` : ''}${lane.cards.length}</span><div class="lane-actions">${iconButton('edit-lane', `Edit ${lane.name} lane`, 'more', `data-id="${lane.id}"`)}${iconButton('add-card', `Add card to ${lane.name}`, 'plus', `data-lane-id="${lane.id}"`)}</div></div>
      <div class="lane-cards">${cards.map(cardMarkup).join('')}${!cards.length ? `<div class="empty-lane">${icon(search ? 'search' : 'image')}<p>${search ? 'No matching cards' : 'A blank canvas'}</p><span>${search ? 'Try another search.' : 'Add a card or paste an image.'}</span>${!search ? button('add-card', 'Add your first card', 'plus', 'empty-add', `data-lane-id="${lane.id}"`) : ''}</div>` : ''}</div>
      ${button('add-card', 'Add card', 'plus', 'lane-add', `data-lane-id="${lane.id}"`)}
    </section>`;
  }).join('') + `<button class="add-lane-column" data-action="add-lane">${icon('plus')}<span>Add a lane</span></button>`;
  $('#total-count').textContent = cardCount(p);
  document.querySelectorAll('.project-link').forEach((node) => {
    const item = board.projects.find((item) => item.id === node.dataset.id);
    if (item) $('.project-count', node).textContent = cardCount(item);
  });
}
function makeCard(laneId) {
  const lane = project()?.lanes.find((item) => item.id === laneId) || project()?.lanes[0];
  if (!lane) return toast('Add a lane first.');
  const card = { id: id(), title: '', originalVideoUrl: '', originalVideoTitle: '', titleOptions: '', prompt: '', intro: '', script: '', publishedVideoUrl: '', images: [], coverImageId: null, originalImageId: null, inspirationImageId: null };
  lane.cards.push(card);
  changed(card);
  renderBoard();
  openCard(card.id);
  return card;
}
function openCard(targetId) {
  const found = locateCard(targetId);
  if (!found) return;
  cardId = targetId;
  lastCardTrigger = document.activeElement;
  const { card, lane, project: p } = found;
  cardDialog.innerHTML = `<div class="editor-header"><div class="editor-breadcrumb">${icon('board')}<span>${escape(p.name)}</span>${icon('chevron')}<label class="sr-only" for="card-lane">Move card to lane</label><select id="card-lane">${p.lanes.map((item) => `<option value="${item.id}" ${item.id === lane.id ? 'selected' : ''}>${escape(item.name)}</option>`).join('')}</select></div><div class="editor-header-right"><span class="save-status" data-save-status></span>${iconButton('close-card', 'Close card editor', 'close')}</div></div>
    <div id="editor-save-error" class="error-banner" role="alert" hidden></div>
    <section class="original-video"><label for="card-original-video-url">Original URL</label><div class="original-video-row"><input class="form-input" id="card-original-video-url" type="url" maxlength="4096" placeholder="Paste a YouTube link…" value="${escape(card.originalVideoUrl || '')}" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="video-link-row" id="card-original-video-url-link">${originalVideoMarkup(card)}</div></div></section>
    <div class="editor-title"><label class="sr-only" for="card-title">Card title</label><input id="card-title" placeholder="Untitled card" maxlength="500" value="${escape(card.title)}" autocomplete="off"><span class="editor-title-hint">Give your idea a name</span></div>
    <div class="editor-content"><div class="writing-panel">
      <section class="writing-section title-options-section"><div class="field-heading"><label for="card-title-options">Title Options</label><span>Try a few different angles</span></div><textarea id="card-title-options" maxlength="200000" placeholder="Brainstorm titles here, one idea per line…">${escape(card.titleOptions || '')}</textarea></section>
      <section class="writing-section intro-section"><div class="field-heading"><label for="card-intro">Intro</label><div class="field-tools"><span>The opening thought</span>${button('copy-field', 'Copy intro', null, 'button small secondary', 'data-field="intro"')}</div></div><textarea id="card-intro" maxlength="200000" placeholder="What's the hook? Start with the idea that pulls people in…">${escape(card.intro)}</textarea></section>
      <section class="writing-section script-section"><div class="field-heading"><label for="card-script">Script</label><div class="field-tools"><span id="script-count">${wordCount(card.script).toLocaleString()} words</span>${button('copy-field', 'Copy script', null, 'button small secondary', 'data-field="script"')}</div></div><textarea id="card-script" maxlength="1000000" placeholder="Make room for the full story. Write your script here…">${escape(card.script)}</textarea></section>
      <section class="writing-section prompt-section"><div class="field-heading"><label for="card-prompt">Prompt</label><span>Instructions for this idea</span></div><textarea id="card-prompt" maxlength="200000" placeholder="Add the prompt you want to use for this card…">${escape(card.prompt || '')}</textarea></section>
      ${videoUrlField('card-published-video-url', 'Published video', card.publishedVideoUrl)}
      <section class="writing-section original-title-section"><div class="field-heading"><label for="card-original-video-title">Original video title</label></div><input class="form-input" id="card-original-video-title" maxlength="500" placeholder="The video that inspired this idea…" value="${escape(card.originalVideoTitle || '')}" autocomplete="off"></section>
    </div>
    <aside class="images-panel" aria-label="Card images"><div class="field-heading"><h2>Images</h2><span id="image-count"></span></div><div id="card-images"></div><label class="image-drop" id="image-drop">${icon('upload')}<strong>Add some inspiration</strong><span>Drop images here or <u>browse files</u></span><span class="paste-shortcut">You can also paste anywhere in this card</span><input id="image-files" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple aria-label="Upload images"></label><p class="image-note">PNG, JPG, WebP, GIF or AVIF · up to 20 MB each</p><p id="upload-status" class="upload-status" role="status"></p></aside></div>
    <div class="editor-footer">${button('delete-card', 'Delete card', 'trash', 'text-button danger')}${button('copy-trifecta', 'Trifecta copy', 'text', 'button secondary')}<span class="edited-at" data-edited-card="${card.id}">${lastEditedMarkup(card)}</span>${button('close-card', 'Done', 'check', 'button primary')}</div>`;
  renderImages();
  renderStatus();
  if (!cardDialog.open) cardDialog.showModal();
  if (!card.title) $(card.originalVideoUrl ? '#card-title' : '#card-original-video-url').focus();
}
function renderImages() {
  const found = locateCard();
  if (!found || !$('#card-images')) return;
  const { card } = found;
  $('#image-count').textContent = `${card.images.length} ${card.images.length === 1 ? 'image' : 'images'}`;
  const cover = card.images.find((image) => image.id === card.coverImageId);
  $('#card-images').innerHTML = `${cover ? `<div class="display-image"><button data-action="preview-image" data-id="${cover.id}" aria-label="Preview display image"><img src="${imageURL(cover.id)}" alt="${escape(cover.name)}"></button><span class="display-badge">${icon('star')} Display image</span></div>` : `<div class="display-placeholder">${icon('image')}<span>Your images go here</span><small>The display image appears on your board.</small></div>`}
    ${card.images.length ? `<p class="gallery-heading">Choose the display, original, and inspiration images for this card.</p><div class="image-gallery">${card.images.map((item) => `<div class="image-tile ${item.id === card.coverImageId ? 'is-display' : ''}"><button class="thumbnail" data-action="preview-image" data-id="${item.id}" aria-label="Preview ${escape(item.name)}"><img src="${imageURL(item.id)}" alt="${escape(item.name)}" loading="lazy"></button>${iconButton('remove-image', `Remove ${item.name}`, 'close', `data-id="${item.id}"`)}<div class="image-flags"><button class="set-display" data-action="set-display" data-id="${item.id}" aria-pressed="${item.id === card.coverImageId}">${icon(item.id === card.coverImageId ? 'check' : 'star')}${item.id === card.coverImageId ? 'Display image' : 'Set as display'}</button><button class="set-image-role ${item.id === card.originalImageId ? 'selected' : ''}" data-action="set-image-role" data-role="original" data-id="${item.id}" aria-pressed="${item.id === card.originalImageId}">${item.id === card.originalImageId ? '✓ ' : ''}Original</button><button class="set-image-role ${item.id === card.inspirationImageId ? 'selected' : ''}" data-action="set-image-role" data-role="inspiration" data-id="${item.id}" aria-pressed="${item.id === card.inspirationImageId}">${item.id === card.inspirationImageId ? '✓ ' : ''}Inspiration</button></div></div>`).join('')}</div>` : ''}`;
}
function closeCard() {
  cardDialog.close();
}
cardDialog.addEventListener('close', () => {
  cardId = null;
  renderBoard();
  save();
  if (lastCardTrigger?.isConnected) lastCardTrigger.focus();
  else $('[data-action="add-card"]')?.focus();
});
function smallForm({ title, description = '', fields = '', submit = 'Save changes', danger = false, onSubmit, extra = '' }) {
  if (formDialog.open) formDialog.close();
  formDialog.innerHTML = `<form id="small-form"><div class="small-dialog-header"><h2 id="form-heading">${escape(title)}</h2>${iconButton('close-form', 'Close dialog', 'close')}</div>${description ? `<p class="dialog-description">${escape(description)}</p>` : ''}${fields}<div class="small-dialog-footer">${extra}<div>${button('close-form', 'Cancel', null, 'button secondary')}<button type="submit" class="button ${danger ? 'destructive' : 'primary'}">${escape(submit)}</button></div></div></form>`;
  $('#small-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.has('name') && !String(data.get('name')).trim()) {
      $('#name-input').setCustomValidity('Please enter a name.');
      $('#name-input').reportValidity();
      return;
    }
    formDialog.close();
    onSubmit(data);
  });
  formDialog.showModal();
  const input = $('#name-input') || $('#prompt-input');
  if (input) {
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.focus();
    if (input.id === 'name-input') input.select();
  }
}
const nameField = (value = '', placeholder = 'Project name', max = 150) => `<label class="form-label" for="name-input">${placeholder}</label><input class="form-input" id="name-input" name="name" value="${escape(value)}" placeholder="${placeholder === 'Project name' ? 'e.g. YouTube ideas' : 'e.g. Ready to film'}" maxlength="${max}" required autocomplete="off">`;
function editProject(isNew = false) {
  const p = project();
  smallForm({ title: isNew ? 'A new space for your ideas' : 'Project settings', fields: nameField(isNew ? '' : p.name), submit: isNew ? 'Create project' : 'Save changes', extra: isNew ? '' : button('delete-project', 'Delete project', 'trash', 'text-button danger'), onSubmit: (data) => {
    if (isNew) {
      const next = { id: id(), name: data.get('name').trim(), lanes: ['Ideas', 'In progress', 'Review', 'Done'].map((name, i) => ({ id: id(), name, color: palette[i], cards: [] })) };
      board.projects.push(next);
      projectId = next.id;
      rememberProject();
      query = '';
    } else p.name = data.get('name').trim();
    changed();
    renderApp();
  } });
}
function editLane(laneId) {
  const p = project();
  const lane = p.lanes.find((item) => item.id === laneId);
  smallForm({ title: lane ? 'Edit lane' : 'Add a lane', fields: nameField(lane?.name, 'Lane name', 100) + `<fieldset class="color-field"><legend>Lane color</legend>${palette.map((color) => `<label class="color-option ${color}" title="${color}"><input type="radio" name="color" value="${color}" ${color === (lane?.color || palette[p.lanes.length % palette.length]) ? 'checked' : ''}><span>${icon('check')}<span class="sr-only">${color}</span></span></label>`).join('')}</fieldset>${lane ? `<label class="form-label" for="lane-position">Position</label><select class="form-input" id="lane-position" name="position">${p.lanes.map((item, index) => `<option value="${index}" ${item.id === laneId ? 'selected' : ''}>${index + 1}${index === 0 ? ' · First lane' : index === p.lanes.length - 1 ? ' · Last lane' : ''}</option>`).join('')}</select>` : ''}`, submit: lane ? 'Save changes' : 'Add lane', extra: lane ? button('delete-lane', 'Delete lane', 'trash', 'text-button danger', `data-id="${laneId}"`) : '', onSubmit: (data) => {
    if (lane) {
      lane.name = data.get('name').trim();
      lane.color = data.get('color');
      p.lanes.splice(p.lanes.indexOf(lane), 1);
      p.lanes.splice(Number(data.get('position')), 0, lane);
    } else p.lanes.push({ id: id(), name: data.get('name').trim(), color: data.get('color'), cards: [] });
    changed();
    renderBoard();
    // Enable the new-card action when adding the first lane.
    $('.header-actions [data-action="add-card"]').disabled = !p.lanes.length;
  } });
}
function confirmDelete(title, description, onSubmit) {
  smallForm({ title, description, submit: 'Delete', danger: true, onSubmit });
}
function setProjectPrompt() {
  const p = project();
  const cards = p.lanes.flatMap((lane) => lane.cards);
  if (!cards.length) return toast('Add a card before applying a shared prompt.');
  const current = cards.map((card) => card.prompt || '');
  const commonPrompt = current.every((prompt) => prompt === current[0]) ? current[0] : '';
  smallForm({
    title: 'Set prompt for all cards',
    description: `This replaces the prompt on all ${cards.length} cards in “${p.name}”.`,
    fields: `<label class="form-label" for="prompt-input">Shared prompt</label><textarea class="form-input prompt-input" id="prompt-input" name="prompt" maxlength="200000" placeholder="Write the prompt to apply to every card…">${escape(commonPrompt)}</textarea>`,
    submit: 'Apply to all cards',
    onSubmit: (data) => {
      const prompt = String(data.get('prompt') || '');
      const updatedAt = new Date().toISOString();
      for (const card of cards) {
        card.prompt = prompt;
        card.updatedAt = updatedAt;
      }
      changed();
      renderBoard();
      toast(`Prompt applied to ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}.`);
    },
  });
}
function moveCard(targetId, laneId, beforeId = null) {
  const source = locateCard(targetId);
  const destination = project()?.lanes.find((lane) => lane.id === laneId);
  if (!source || !destination || targetId === beforeId) return;
  const oldIndex = source.lane.cards.indexOf(source.card);
  source.lane.cards.splice(oldIndex, 1);
  const beforeIndex = destination.cards.findIndex((card) => card.id === beforeId);
  destination.cards.splice(beforeIndex < 0 ? destination.cards.length : beforeIndex, 0, source.card);
  if (source.lane === destination && destination.cards.indexOf(source.card) === oldIndex) return;
  changed(source.card);
  renderBoard();
}
function rememberProject() {
  try { localStorage.setItem('frameboard-project', projectId || ''); } catch { /* The board itself is stored on disk. */ }
}
async function fetchYoutube(target) {
  const targetCardId = cardId;
  const { card } = locateCard(targetCardId);
  const url = card.originalVideoUrl.trim();
  target.disabled = true;
  target.setAttribute('aria-busy', 'true');
  target.lastChild.textContent = 'Fetching…';
  uploads++;
  renderStatus();
  try {
    const result = await request('/api/youtube', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    const found = locateCard(targetCardId);
    if (!found) return;
    const current = found.card;
    if (current.originalVideoUrl.trim() !== url) return toast('The Original URL changed while fetching. Fetch again for the new link.');
    // Replace the thumbnail from an earlier fetch instead of piling up copies.
    const previous = current.originalImageId;
    if (previous && current.images.find((image) => image.id === previous)?.name.endsWith(' thumbnail.jpg')) {
      current.images = current.images.filter((image) => image.id !== previous);
      if (current.coverImageId === previous) current.coverImageId = null;
    }
    if (current.images.length >= 200) throw new Error('A card can hold up to 200 images.');
    current.images.unshift(result.image);
    current.originalImageId = result.image.id;
    current.coverImageId ||= result.image.id;
    current.originalVideoTitle = result.title;
    if (!current.title.trim()) current.title = result.title;
    changed(current);
    if (cardId === targetCardId) {
      $('#card-title').value = current.title;
      $('#card-original-video-title').value = current.originalVideoTitle;
      renderImages();
    }
    renderBoard();
    toast('Title and thumbnail added.');
  } catch (error) {
    toast(error.message);
  } finally {
    uploads--;
    renderStatus();
    if (cardId === targetCardId && $('#card-original-video-url-link')) $('#card-original-video-url-link').innerHTML = originalVideoMarkup(locateCard(targetCardId).card);
    save();
  }
}
async function addImages(files, targetCardId) {
  const candidates = [...files];
  if (!candidates.length) return;
  uploads++;
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
        found.card.coverImageId ||= result.id;
        added++;
        changed(found.card);
        if (cardId === targetCardId) renderImages();
        renderBoard();
      } catch (error) { errors.push(error.message); }
    }
  } finally {
    uploads--;
    renderStatus();
    const message = errors.length ? `${added ? `${added} added. ` : ''}${errors.join(' ')}` : `${added} ${added === 1 ? 'image' : 'images'} added.`;
    if (cardId === targetCardId && $('#upload-status')) $('#upload-status').textContent = message;
    toast(message);
    save();
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const targetId = target.dataset.id;
  const action = target.dataset.action;
  if (action === 'add-project') editProject(true);
  if (action === 'edit-project') editProject();
  if (action === 'switch-project') {
    projectId = targetId;
    pasteLaneId = null;
    query = '';
    rememberProject();
    renderApp();
  }
  if (action === 'toggle-sidebar') $('.sidebar').classList.toggle('mobile-open');
  if (action === 'set-project-prompt') setProjectPrompt();
  if (action === 'add-lane') editLane();
  if (action === 'edit-lane') editLane(targetId);
  if (action === 'add-card') makeCard(target.dataset.laneId);
  if (action === 'open-card') openCard(targetId);
  if (action === 'close-card') closeCard();
  if (action === 'close-form') formDialog.close();
  if (action === 'close-image') imageDialog.close();
  if (action === 'retry-save') save();
  if (action === 'copy-field') {
    const field = target.dataset.field;
    const name = field === 'intro' ? 'Intro' : 'Script';
    return copyText(locateCard().card[field], name);
  }
  if (action === 'copy-trifecta') return copyTrifecta(target);
  if (action === 'fetch-youtube') return fetchYoutube(target);
  if (action === 'delete-project') {
    const p = project();
    confirmDelete(`Delete “${p.name}”?`, `This will delete the project, its lanes, and ${cardCount(p)} cards. This cannot be undone.`, () => {
      board.projects = board.projects.filter((item) => item.id !== p.id);
      projectId = board.projects[0]?.id;
      rememberProject();
      changed();
      renderApp();
      toast('Project deleted.');
    });
  }
  if (action === 'delete-lane') {
    const lane = project().lanes.find((item) => item.id === targetId);
    confirmDelete(`Delete “${lane.name}”?`, `This will also delete ${lane.cards.length} ${lane.cards.length === 1 ? 'card' : 'cards'} in this lane. Move any cards you want to keep to another lane first.`, () => {
      project().lanes = project().lanes.filter((item) => item.id !== targetId);
      changed();
      renderApp();
      toast('Lane deleted.');
    });
  }
  if (action === 'delete-card') {
    const found = locateCard();
    confirmDelete('Delete this card?', `“${found.card.title || 'Untitled card'}” and its text and images will be removed from the board. This cannot be undone.`, () => {
      found.lane.cards = found.lane.cards.filter((card) => card.id !== found.card.id);
      changed();
      closeCard();
      renderBoard();
      toast('Card deleted.');
    });
  }
  if (action === 'set-display') {
    const { card } = locateCard();
    if (card.coverImageId === targetId) return;
    card.coverImageId = targetId;
    changed(card);
    renderImages();
    renderBoard();
  }
  if (action === 'set-image-role') {
    const { card } = locateCard();
    const field = target.dataset.role === 'original' ? 'originalImageId' : 'inspirationImageId';
    card[field] = card[field] === targetId ? null : targetId;
    changed(card);
    renderImages();
  }
  if (action === 'remove-image') {
    const found = locateCard();
    const item = found.card.images.find((image) => image.id === targetId);
    confirmDelete('Remove this image?', `Remove “${item.name}” from this card?`, () => {
      found.card.images = found.card.images.filter((image) => image.id !== targetId);
      if (found.card.coverImageId === targetId) found.card.coverImageId = found.card.images[0]?.id || null;
      if (found.card.originalImageId === targetId) found.card.originalImageId = null;
      if (found.card.inspirationImageId === targetId) found.card.inspirationImageId = null;
      changed(found.card);
      renderImages();
      renderBoard();
    });
  }
  if (action === 'preview-image') {
    const item = locateCard().card.images.find((image) => image.id === targetId);
    imageDialog.innerHTML = `${iconButton('close-image', 'Close image preview', 'close')}<img src="${imageURL(item.id)}" alt="${escape(item.name)}"><p>${escape(item.name)}</p>`;
    imageDialog.showModal();
  }
});
document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'search') { query = target.value; renderBoard(); }
  const fields = { 'card-title': 'title', 'card-original-video-url': 'originalVideoUrl', 'card-title-options': 'titleOptions', 'card-prompt': 'prompt', 'card-intro': 'intro', 'card-script': 'script', 'card-original-video-title': 'originalVideoTitle', 'card-published-video-url': 'publishedVideoUrl' };
  if (fields[target.id] && locateCard()) {
    const { card } = locateCard();
    if (card[fields[target.id]] === target.value) return;
    card[fields[target.id]] = target.value;
    if (target.id === 'card-script') $('#script-count').textContent = `${wordCount(target.value).toLocaleString()} words`;
    if (target.id === 'card-original-video-url') $('#card-original-video-url-link').innerHTML = originalVideoMarkup(card);
    if (target.id === 'card-published-video-url') $(`#${target.id}-link`).innerHTML = videoLinkMarkup(target.value, 'published video');
    changed(card);
  }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'card-lane') moveCard(cardId, event.target.value);
  if (event.target.id === 'image-files') {
    addImages(event.target.files, cardId);
    event.target.value = '';
  }
});
document.addEventListener('focusin', (event) => {
  const lane = event.target.closest('[data-lane]');
  if (lane) pasteLaneId = lane.dataset.lane;
});
document.addEventListener('paste', (event) => {
  if (!board || formDialog.open || imageDialog.open) return;
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  if (!cardDialog.open && event.target.closest('input, textarea, [contenteditable]')) return;
  event.preventDefault();
  let targetId = cardDialog.open ? cardId : null;
  if (!targetId) targetId = makeCard(pasteLaneId)?.id;
  if (targetId) addImages(files, targetId);
});
document.addEventListener('dragstart', (event) => {
  const card = event.target.closest('[data-card]');
  if (!card) return;
  draggedId = card.dataset.card;
  event.dataTransfer.setData('text/plain', draggedId);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
function clearDrag() { document.querySelectorAll('.drag-over, .drop-before, .dragging').forEach((node) => node.classList.remove('drag-over', 'drop-before', 'dragging')); }
document.addEventListener('dragend', () => { draggedId = null; clearDrag(); });
document.addEventListener('dragover', (event) => {
  const files = event.dataTransfer.types.includes('Files');
  if (files) event.preventDefault();
  if (formDialog.open || imageDialog.open) return;
  if (cardDialog.open && files) { $('#image-drop').classList.add('drag-over'); return; }
  const lane = event.target.closest('[data-lane]');
  if (!lane || (!files && !draggedId)) return;
  event.preventDefault();
  document.querySelectorAll('.drag-over, .drop-before').forEach((node) => node.classList.remove('drag-over', 'drop-before'));
  lane.classList.add('drag-over');
  const card = event.target.closest('[data-card]');
  if (card && card.dataset.card !== draggedId && !files) card.classList.add('drop-before');
  event.dataTransfer.dropEffect = files ? 'copy' : 'move';
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) clearDrag();
  const lane = event.target.closest('[data-lane]');
  if (lane && !lane.contains(event.relatedTarget)) lane.classList.remove('drag-over');
});
document.addEventListener('drop', (event) => {
  const files = [...event.dataTransfer.files];
  if (files.length) event.preventDefault();
  clearDrag();
  if (formDialog.open || imageDialog.open) return;
  if (cardDialog.open && files.length) { addImages(files, cardId); return; }
  const lane = event.target.closest('[data-lane]');
  if (!lane) return;
  event.preventDefault();
  if (files.length) {
    if (!files.some((file) => file.type.startsWith('image/'))) return toast('Drop image files to create a card.');
    const card = makeCard(lane.dataset.lane);
    if (card) addImages(files, card.id);
  } else if (draggedId) moveCard(draggedId, lane.dataset.lane, event.target.closest('[data-card]')?.dataset.card);
  draggedId = null;
});
for (const dialog of [cardDialog, formDialog, imageDialog]) {
  let downOnBackdrop = false;
  dialog.addEventListener('pointerdown', (event) => { downOnBackdrop = event.target === dialog && (event.offsetX < 0 || event.offsetY < 0 || event.offsetX > dialog.clientWidth || event.offsetY > dialog.clientHeight); });
  dialog.addEventListener('click', (event) => { if (downOnBackdrop && event.target === dialog) dialog.close(); downOnBackdrop = false; });
}
window.addEventListener('beforeunload', (event) => {
  if (dirty || saving || uploads) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
window.addEventListener('online', () => { if (dirty) save(); });

try {
  const result = await request('/api/board');
  board = result.board;
  revision = result.revision;
  try { projectId = localStorage.getItem('frameboard-project'); } catch { /* Optional preference. */ }
  if (!project()) projectId = board.projects[0]?.id;
  renderApp();
} catch (error) {
  app.innerHTML = `<div class="loading-screen"><h1>Couldn’t open your workspace</h1><p>${escape(error.message)}</p><p>Make sure the local server is running, then reload this page.</p><a class="button primary" href="/">Try again</a></div>`;
}
