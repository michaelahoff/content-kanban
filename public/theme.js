// Applies the saved light or dark theme before the page paints, so there is no
// flash of the other one. Until a theme is chosen, Frameboard follows the system.
(() => {
  let saved = null;
  try { saved = localStorage.getItem('frameboard-theme'); } catch { /* Optional display preference. */ }
  const theme = saved === 'light' || saved === 'dark' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  let accent = null;
  try { accent = localStorage.getItem('frameboard-accent'); } catch { /* Optional display preference. */ }
  document.documentElement.dataset.accent = ['blue', 'cyan', 'red', 'mint'].includes(accent) ? accent : 'blue';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f0f0f' : '#ffffff');
})();
