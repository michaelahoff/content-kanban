// Card templates describe the text fields a card carries. The server validates
// against them and the browser uses them for new cards, search, and the editor. Only one
// template exists today; more can be added without changing the storage shape.
export const templates = {
  'youtube-video': {
    id: 'youtube-video',
    name: 'YouTube video',
    title: { label: 'Card title', max: 500 },
    fields: [
      { key: 'originalVideoUrl', label: 'Original URL', max: 4096, control: 'url', placement: 'header', videoLabel: 'original video', youtube: true, placeholder: 'Paste a YouTube link…' },
      { key: 'titleOptions', label: 'Title Options', max: 200000, control: 'textarea', section: 'title-options', placeholder: 'Brainstorm titles here, one idea per line…' },
      { key: 'intro', label: 'Intro', max: 200000, control: 'textarea', section: 'intro', copy: true, placeholder: "What's the hook? Start with the idea that pulls people in…" },
      { key: 'script', label: 'Script', max: 1000000, control: 'textarea', section: 'script', countWords: true, copy: true, placeholder: 'Make room for the full story. Write your script here…' },
      // Prompt is set with Set prompt or lane commands and used by Trifecta copy; the editor doesn't show it.
      { key: 'prompt', label: 'Prompt', max: 200000, control: 'textarea', editor: false },
      { key: 'publishedVideoUrl', label: 'Published video URL', max: 4096, control: 'url', videoLabel: 'published video', placeholder: 'https://…' },
      { key: 'originalVideoTitle', label: 'Original video title', max: 500, control: 'text', section: 'original-title', placeholder: 'The video that inspired this idea…' },
    ],
    // The display image is always available as "cover"; these are extra flags.
    imageRoles: ['original', 'inspiration'],
  },
};

export const defaultTemplate = 'youtube-video';
export const fieldInputId = (key) => `card-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

export function emptyFields(templateId = defaultTemplate) {
  return Object.fromEntries(templates[templateId].fields.map((field) => [field.key, '']));
}

export function emptyImageRoles(templateId = defaultTemplate) {
  return Object.fromEntries(['cover', ...templates[templateId].imageRoles].map((role) => [role, null]));
}
