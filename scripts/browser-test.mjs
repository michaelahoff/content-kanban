import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const temporary = await mkdtemp(path.join(tmpdir(), 'frameboard-browser-'));
// Stand-in for YouTube so the checks run offline.
const fakeYoutube = async (url) => url.startsWith('https://www.youtube.com/oembed')
  ? new Response(JSON.stringify({ title: 'A borrowed idea' }))
  : new Response(Buffer.from([255, 216, 255, 224, 0, 16]));
const server = await createApp({ dataDir: path.join(temporary, 'data'), fetch: fakeYoutube });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(process.env.CHROME_PATH || 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'chrome')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const pending = new Map();
const browserErrors = [];
let sequence = 0;
let sessionId;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const websocket = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Chromium did not start: ${output}`)), 15000);
    chrome.on('error', (error) => { clearTimeout(timer); reject(error); });
    chrome.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited (${code}): ${output}`)); });
    chrome.stderr.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(websocket);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails);
    if (message.id) {
      const handler = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
    }
  };
  const send = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression) => {
    for (let attempt = 0; attempt < 120; attempt++) { if (await evaluate(expression)) return; await pause(50); }
    throw new Error(`Timed out: ${expression}`);
  };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const select = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const saved = () => waitFor(`document.querySelector('[data-save-status]')?.textContent.includes('All changes saved')`);
  const snapshot = async (name) => {
    await evaluate(`Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))`);
    await mkdir('test-results', { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`test-results/${name}.png`, Buffer.from(data, 'base64'));
  };
  const state = async () => (await (await fetch(`${base}/api/board`)).json()).board;
  await send('Page.navigate', { url: base });
  await waitFor(`document.querySelectorAll('.lane').length === 4`);
  await snapshot('empty-board');
  console.log('PASS initial board loads');

  await click('.header-actions [data-action="add-card"]');
  await waitFor(`document.querySelector('#card-dialog').open`);
  const createdTimestamp = await evaluate(`document.querySelector('#card-dialog .edited-at time').dateTime`);
  assert.ok(Number.isFinite(Date.parse(createdTimestamp)));
  await fill('#card-title', 'A quiet morning');
  await fill('#card-title-options', 'Before the city wakes\nSmall rituals');
  await fill('#card-intro', 'The city wakes up before anyone notices.\nStart with the little details.');
  await fill('#card-script', 'Open on the window.\nA kettle boils in the background.\nCut to the empty street.');
  await fill('#card-original-video-title', 'A study in stillness');
  for (const field of ['card-original-video-url', 'card-published-video-url']) {
    for (const invalid of ['javascript:alert(1)', 'data:text/html,hello', 'unfinished']) {
      await fill(`#${field}`, invalid);
      assert.equal(await evaluate(`document.querySelector('#${field}-link a')`), null);
    }
  }
  await saved();
  assert.equal((await state()).projects[0].lanes[0].cards[0].originalVideoUrl, 'unfinished');
  await fill('#card-original-video-url', `${base}/?video=original&reference=1`);
  await fill('#card-published-video-url', `${base}/?video=published`);
  for (const [field, url] of [['card-original-video-url', `${base}/?video=original&reference=1`], ['card-published-video-url', `${base}/?video=published`]]) {
    assert.equal(await evaluate(`document.querySelector('#${field}-link a').href`), url);
    await click(`#${field}-link a`);
    let opened;
    for (let attempt = 0; attempt < 60; attempt++) {
      opened = (await send('Target.getTargets', {}, null)).targetInfos.find((target) => target.url === url);
      if (opened) break;
      await pause(50);
    }
    assert.ok(opened, 'Video link opens its webpage in a new tab');
    await send('Target.closeTarget', { targetId: opened.targetId }, null);
    await send('Target.activateTarget', { targetId }, null);
  }
  console.log('PASS video fields save drafts and open valid webpages in new tabs');
  // Make two valid, visually distinct image fixtures inside the browser.
  await evaluate(`(async () => {
    window.testImages = [];
    for (const [index, color] of ['#9c8ea7', '#648c89'].entries()) {
      const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 550;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 900, 550);
      ctx.fillStyle = '#ffffff22'; ctx.fillRect(70, 0, 12, 550); ctx.fillRect(430, 0, 12, 550); ctx.fillRect(0, 290, 900, 12);
      ctx.fillStyle = '#ffffff77'; ctx.font = '36px sans-serif'; ctx.fillText(index ? 'An alternate frame' : 'A quiet morning', 70, 440);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      window.testImages.push(new File([blob], 'frame-' + index + '.png', { type: 'image/png' }));
    }
    const transfer = new DataTransfer(); window.testImages.forEach(file => transfer.items.add(file));
    const input = document.querySelector('#image-files'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(`document.querySelectorAll('.image-tile').length === 2 && document.querySelector('#upload-status').textContent.includes('2 images added')`);
  await click('.image-tile:nth-child(2) [data-action="set-display"]');
  await saved();
  assert.match(await evaluate(`document.querySelector('.is-display img').alt`), /frame-1/);
  await snapshot('card-editor');
  const edited = (await state()).projects[0].lanes[0].cards[0];
  assert.equal(edited.title, 'A quiet morning');
  assert.equal(edited.titleOptions, 'Before the city wakes\nSmall rituals');
  assert.equal(edited.originalVideoTitle, 'A study in stillness');
  assert.equal(edited.originalVideoUrl, `${base}/?video=original&reference=1`);
  assert.equal(edited.publishedVideoUrl, `${base}/?video=published`);
  assert.equal(edited.images.length, 2);
  assert.equal(edited.coverImageId, edited.images[1].id);
  assert.ok(Date.parse(edited.updatedAt) > Date.parse(createdTimestamp));
  assert.equal(await evaluate(`document.querySelector('#card-dialog .edited-at time').dateTime`), edited.updatedAt);
  await click('.image-tile.is-display [data-action="set-display"]');
  assert.equal(await evaluate(`document.querySelector('#card-dialog .edited-at time').dateTime`), edited.updatedAt);
  console.log('PASS card text, multiple uploads, display image, autosave');

  // Exercise actual clipboard paste through Chromium, not just the file picker.
  await send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }, null);
  await fill('#card-prompt', 'Compare the original and inspiration.\nSuggest a stronger hook.');
  await click('.image-tile:nth-child(1) [data-role="original"]');
  await click('.image-tile:nth-child(2) [data-role="inspiration"]');
  await click('[data-action="copy-trifecta"]');
  await waitFor(`document.querySelector('#toast').textContent.includes('Trifecta copied')`);

  // A separate origin receives a real Ctrl+V, using the file handling common to chat inputs.
  const sourceSession = sessionId;
  const receiver = await send('Target.createTarget', { url: base.replace('127.0.0.1', 'localhost') });
  sessionId = (await send('Target.attachToTarget', { targetId: receiver.targetId, flatten: true })).sessionId;
  await send('Runtime.enable');
  await send('Page.enable');
  await waitFor(`document.querySelectorAll('.lane').length === 4`);
  await evaluate(`(() => {
    document.body.innerHTML = '<textarea id="paste-target" aria-label="Chat message"></textarea>';
    document.addEventListener('paste', async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const files = [...event.clipboardData.files];
      const text = event.clipboardData.getData('text/plain');
      const types = [...event.clipboardData.types];
      const colors = new Set();
      let imageData;
      for (const file of files) {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
        imageData = canvas.toDataURL('image/png');
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) {
          const rgb = pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2];
          if (rgb === '156,142,167' || rgb === '100,140,137') colors.add(rgb);
        }
        bitmap.close();
      }
      window.pastedTrifecta = { text, types, files: files.map((file) => file.type), colors: [...colors], imageData };
    }, { capture: true, once: true });
    document.querySelector('#paste-target').focus();
  })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
  await waitFor('!!window.pastedTrifecta');
  const pasted = await evaluate('window.pastedTrifecta');
  console.log('Trifecta paste types:', pasted.types.join(', '));
  assert.deepEqual(pasted.files, ['image/png'], 'Trifecta must paste actual image data into a different page');
  assert.deepEqual(pasted.colors.sort(), ['100,140,137', '156,142,167'], 'Both flagged images must survive the paste');
  assert.match(pasted.text, /^PROMPT\nCompare the original and inspiration/);
  assert.ok(pasted.text.includes('Before the city wakes'));
  assert.ok(pasted.text.includes('The city wakes up before anyone notices.'));
  await writeFile('test-results/trifecta-paste.png', Buffer.from(pasted.imageData.split(',')[1], 'base64'));
  await send('Target.closeTarget', { targetId: receiver.targetId }, null);
  sessionId = sourceSession;
  await send('Page.bringToFront');
  console.log('PASS Trifecta pastes PNG containing both images and prompt-first text across origins');

  // An image preparation failure must not silently overwrite the packet with names/text.
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Network.setBlockedURLs', { urls: [`${base}/images/*`] });
  await click('[data-action="copy-trifecta"]');
  await waitFor(`document.querySelector('#toast').textContent.includes('Trifecta was not copied')`);
  assert.equal(await evaluate('navigator.clipboard.readText()'), pasted.text);
  assert.equal(await evaluate(`document.querySelector('[data-action="copy-trifecta"]').disabled`), false);
  await send('Network.setBlockedURLs', { urls: [] });
  await send('Network.setCacheDisabled', { cacheDisabled: false });
  console.log('PASS failed image copy reports failure and preserves the previous clipboard');

  await evaluate(`navigator.clipboard.write([new ClipboardItem({ 'image/png': window.testImages[0] })])`);
  await evaluate(`document.querySelector('#card-intro').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
  await waitFor(`document.querySelectorAll('.image-tile').length === 3`);
  await saved();
  console.log('PASS real clipboard image paste inside editor');

  const secondLane = (await state()).projects[0].lanes[1].id;
  await select('#card-lane', secondLane);
  await click('#card-dialog [data-action="close-card"]');
  await saved();
  const movedTimestamp = (await state()).projects[0].lanes[1].cards[0].updatedAt;
  assert.ok(Date.parse(movedTimestamp) > Date.parse(edited.updatedAt));
  await evaluate('window.beforeReload = true');
  await send('Page.reload');
  await waitFor(`!window.beforeReload && document.querySelector('[data-lane="${secondLane}"] .card') !== null`);
  await click('[data-action="open-card"]');
  assert.equal(await evaluate(`document.querySelector('#card-dialog .edited-at time').dateTime`), movedTimestamp);
  assert.equal((await state()).projects[0].lanes[1].cards[0].updatedAt, movedTimestamp);
  assert.equal(await evaluate(`document.querySelector('#card-intro').value`), edited.intro);
  assert.equal(await evaluate(`document.querySelector('#card-title-options').value`), edited.titleOptions);
  assert.equal(await evaluate(`document.querySelector('#card-script').value`), edited.script);
  assert.equal(await evaluate(`document.querySelector('#card-original-video-title').value`), edited.originalVideoTitle);
  assert.equal(await evaluate(`document.querySelector('#card-original-video-url').value`), edited.originalVideoUrl);
  assert.equal(await evaluate(`document.querySelector('#card-published-video-url').value`), edited.publishedVideoUrl);
  assert.equal(await evaluate(`document.querySelector('#card-original-video-url-link a').href`), edited.originalVideoUrl);
  assert.equal(await evaluate(`document.querySelectorAll('.image-tile').length`), 3);
  await click('.image-tile.is-display [data-action="remove-image"]');
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelectorAll('.image-tile').length === 2`);
  assert.equal(await evaluate(`document.querySelectorAll('.image-tile.is-display').length`), 1);
  await click('#card-dialog [data-action="close-card"]');
  await saved();
  console.log('PASS lane movement, reload persistence, removing display image');

  // Drag existing card to another lane, then paste a new card into that lane.
  const lanes = (await state()).projects[0].lanes;
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    document.querySelector('.card').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    document.querySelector('[data-lane="${lanes[2].id}"]').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  })()`);
  await saved();
  assert.equal((await state()).projects[0].lanes[2].cards.length, 1);
  await evaluate(`document.querySelector('[data-lane="${lanes[0].id}"]').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', modifiers: 2, windowsVirtualKeyCode: 86 });
  await waitFor(`document.querySelector('#card-dialog').open && document.querySelectorAll('.image-tile').length === 1`);
  await fill('#card-title', 'A second idea');
  await click('#card-dialog [data-action="close-card"]');
  await saved();
  await fill('#search', 'kettle');
  assert.equal(await evaluate(`document.querySelectorAll('.card').length`), 1);
  await fill('#search', 'Small rituals');
  assert.equal(await evaluate(`document.querySelectorAll('.card').length`), 1);
  await fill('#search', 'A study in stillness');
  assert.equal(await evaluate(`document.querySelectorAll('.card').length`), 1);
  await fill('#search', '');
  assert.equal(await evaluate(`document.querySelectorAll('.card').length`), 2);
  await snapshot('board-with-cards');
  console.log('PASS drag-and-drop, clipboard creates card, script and title options search');

  await click('.header-actions [data-action="add-lane"]');
  await fill('#name-input', 'Published');
  assert.equal(await evaluate(`document.querySelectorAll('input[name="color"]').length`), 12);
  await click('input[name="color"][value="teal"]');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects[0].lanes.length, 5);
  const addedLane = (await state()).projects[0].lanes.at(-1).id;
  assert.equal((await state()).projects[0].lanes.at(-1).color, 'teal');
  assert.ok(await evaluate(`document.querySelector('[data-lane="${addedLane}"] .lane-dot').classList.contains('teal')`));
  await click(`[data-action="edit-lane"][data-id="${addedLane}"]`);
  await fill('#name-input', 'Archived');
  await click('input[name="color"][value="purple"]');
  await select('#lane-position', '0');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects[0].lanes[0].name, 'Archived');
  assert.equal((await state()).projects[0].lanes[0].color, 'purple');
  await click(`[data-action="edit-lane"][data-id="${addedLane}"]`);
  await click('[data-action="delete-lane"]');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects[0].lanes.length, 4);
  console.log('PASS lane creation, editing, reordering, deletion');

  await click('.new-project');
  await fill('#name-input', 'Another project');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects.length, 2);
  assert.equal(await evaluate(`document.querySelectorAll('.card').length`), 0);
  await click('[data-action="edit-project"]');
  await fill('#name-input', 'Renamed project');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects[1].name, 'Renamed project');
  await click('[data-action="edit-project"]');
  await click('[data-action="delete-project"]');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects.length, 1);
  console.log('PASS project creation, isolation, renaming, deletion');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`));
  await snapshot('mobile-board');
  await click('[data-action="open-card"]');
  await snapshot('mobile-editor');
  assert.ok(await evaluate(`document.querySelector('#card-dialog .edited-at').checkVisibility()`));
  assert.ok(await evaluate(`document.querySelector('#card-dialog').scrollWidth <= document.querySelector('#card-dialog').clientWidth`));
  await click('[data-action="delete-card"]');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects[0].lanes.reduce((sum, lane) => sum + lane.cards.length, 0), 1);
  console.log('PASS mobile layout and card deletion');

  // Paste a YouTube link at the top of a new card, then fetch its title and thumbnail.
  await evaluate(`document.querySelector('#card-dialog').open || document.querySelector('.header-actions [data-action="add-card"]').click()`);
  if (await evaluate(`!!document.querySelector('#card-title').value`)) {
    await click('[data-action="close-card"]');
    await click('.header-actions [data-action="add-card"]');
  }
  await waitFor(`document.activeElement?.id === 'card-original-video-url'`);
  await fill('#card-original-video-url', 'https://example.com/not-youtube');
  assert.equal(await evaluate(`document.querySelector('[data-action="fetch-youtube"]')`), null);
  await fill('#card-original-video-url', 'https://youtu.be/62NJbICVWkQ');
  await click('[data-action="fetch-youtube"]');
  await waitFor(`document.querySelector('#card-title').value === 'A borrowed idea'`);
  await saved();
  const fetchedCard = (await state()).projects[0].lanes.flatMap((lane) => lane.cards).find((card) => card.originalVideoUrl === 'https://youtu.be/62NJbICVWkQ');
  assert.equal(fetchedCard.title, 'A borrowed idea');
  assert.equal(fetchedCard.originalVideoTitle, 'A borrowed idea');
  assert.equal(await evaluate(`document.querySelector('#card-original-video-title').value`), 'A borrowed idea');
  assert.equal(fetchedCard.images.length, 1);
  assert.equal(fetchedCard.originalImageId, fetchedCard.images[0].id);
  assert.equal(fetchedCard.coverImageId, fetchedCard.images[0].id);
  await click('[data-action="fetch-youtube"]');
  await waitFor(`document.querySelector('#upload-status') && document.querySelector('[data-action="fetch-youtube"]') && !document.querySelector('[data-action="fetch-youtube"]').disabled`);
  await saved();
  assert.equal((await state()).projects[0].lanes.flatMap((lane) => lane.cards).find((card) => card.id === fetchedCard.id).images.length, 1);
  await click('[data-action="close-card"]');
  console.log('PASS original URL fetches title and thumbnail');

  // Preserve unsaved text and show actionable feedback if another tab saved first.
  const external = await (await fetch(`${base}/api/board`)).json();
  await fetch(`${base}/api/board`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(external) });
  await click('[data-action="open-card"]');
  await fill('#card-intro', 'This text must not disappear after a conflict.');
  await waitFor(`document.querySelector('#editor-save-error')?.textContent.includes('another tab') && !document.querySelector('#editor-save-error').hidden`);
  assert.equal(await evaluate(`document.querySelector('#card-intro').value`), 'This text must not disappear after a conflict.');
  console.log('PASS save conflict feedback retains unsaved edits');
  assert.deepEqual(browserErrors, []);
  console.log('All browser checks passed. Screenshots: test-results/');
} finally {
  socket?.close();
  chrome.kill();
  await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
