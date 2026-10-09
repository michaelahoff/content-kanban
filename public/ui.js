// Small rendering helpers shared by the board and the card editor.
export const $ = (selector, parent = document) => parent.querySelector(selector);
export const escape = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  undo: '<path d="M3 10h11a6 6 0 0 1 0 12M3 10l5-5M3 10l5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  board: '<rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="10" rx="2"/>',
  playbook: '<path d="M6 3h8l5 5v13H6Z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
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
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  external: '<path d="M14 3h7v7M21 3 11 13M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.board}</svg>`;
export const button = (action, label, symbol, cls = '', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${symbol ? icon(symbol) : ''}${label}</button>`;
export const iconButton = (action, label, symbol, attrs = '') => button(action, '', symbol, 'icon-button', `aria-label="${escape(label)}" title="${escape(label)}" ${attrs}`);
export const id = () => crypto.randomUUID();
export const imageURL = (imageId) => `/images/${encodeURIComponent(imageId)}`;
export const palette = ['lavender', 'blue', 'amber', 'green', 'pink', 'gray', 'teal', 'cyan', 'orange', 'red', 'purple', 'lime'];
const editedDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const formDialog = document.querySelector('#form-dialog');
let toastTimer;

// Light and dark mirror YouTube's, so thumbnails can be judged in both. public/theme.js applies the saved choice on load.
export const currentTheme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
export const themeSwitchMarkup = () => `<div class="theme-switch" role="group" aria-label="Theme">${[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']].map(([theme, label, symbol]) => `<button type="button" class="chip" data-action="set-theme" data-theme="${theme}" aria-pressed="${currentTheme() === theme}">${icon(symbol)}${label}</button>`).join('')}</div>`;
// The dot colors live in styles.css (.accent-dot); theme.js accepts the same ids.
export const accents = [['blue', 'Blue'], ['cyan', 'Cyan'], ['red', 'Red'], ['mint', 'Mint']];
export const currentAccent = () => document.documentElement.dataset.accent || 'blue';
export const accentSwitchMarkup = () => `<div class="accent-switch" role="group" aria-label="Accent color">${accents.map(([accent, label]) => `<button type="button" class="accent-dot" data-action="set-accent" data-accent="${accent}" aria-label="${label} accent" title="${label}" aria-pressed="${currentAccent() === accent}"></button>`).join('')}</div>`;
export function setAccent(accent) {
  document.documentElement.dataset.accent = accent;
  try { localStorage.setItem('frameboard-accent', accent); } catch { /* Optional display preference. */ }
  document.querySelectorAll('[data-action="set-accent"]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.accent === accent)));
}
export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('frameboard-theme', theme); } catch { /* Optional display preference. */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f0f0f' : '#ffffff');
  document.querySelectorAll('[data-action="set-theme"]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.theme === theme)));
}
export function wordCount(text) { return text.trim() ? text.trim().split(/\s+/u).length : 0; }
export function lastEditedMarkup(card) {
  if (!card.updatedAt) return `${icon('clock')}<span>Last edit not recorded</span>`;
  const date = new Date(card.updatedAt);
  const fullDate = date.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' });
  return `${icon('clock')}<time datetime="${escape(card.updatedAt)}" title="${escape(fullDate)}">Edited ${escape(editedDateFormat.format(date))}</time>`;
}
// Refreshes every "Edited …" label for a card, on the board and in the editor.
export function showEdited(card) {
  document.querySelectorAll('[data-edited-card]').forEach((node) => {
    if (node.dataset.editedCard === card.id) node.innerHTML = lastEditedMarkup(card);
  });
}
export function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200);
}
export function smallForm({ title, description = '', fields = '', submit = 'Save changes', danger = false, onSubmit, extra = '' }) {
  if (formDialog.open) formDialog.close();
  formDialog.innerHTML = `<form id="small-form"><div class="small-dialog-header"><h2 id="form-heading">${escape(title)}</h2>${iconButton('close-form', 'Close dialog', 'close')}</div>${description ? `<p class="dialog-description">${escape(description)}</p>` : ''}${fields}<div class="small-dialog-footer">${extra}<div>${button('close-form', 'Cancel', null, 'button secondary')}<button type="submit" class="button ${danger ? 'destructive' : 'primary'}">${escape(submit)}</button></div></div></form>`;
  $('#small-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.has('name') && !String(data.get('name')).trim()) {
      $('#name-input').setCustomValidity('Please enter a name.');
      $('#name-input').reportValidity();
      return;
    }
    const submitButton = $('button[type="submit"]', event.currentTarget);
    submitButton.disabled = true;
    try {
      await onSubmit(data);
      formDialog.close();
    } catch (error) {
      toast(error.message);
    } finally { submitButton.disabled = false; }
  });
  formDialog.showModal();
  const input = $('#name-input') || $('#prompt-input');
  if (input) {
    input.addEventListener('input', () => input.setCustomValidity(''));
    input.focus();
    if (input.id === 'name-input') input.select();
  }
}
export const nameField = (value = '', placeholder = 'Project name', max = 150) => `<label class="form-label" for="name-input">${placeholder}</label><input class="form-input" id="name-input" name="name" value="${escape(value)}" placeholder="${placeholder === 'Project name' ? 'e.g. YouTube ideas' : 'e.g. Ready to film'}" maxlength="${max}" required autocomplete="off">`;
export function confirmDelete(title, description, onSubmit) {
  smallForm({ title, description, submit: 'Delete', danger: true, onSubmit });
}
