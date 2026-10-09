import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { ControlledCodex } from '../test/support/controlled-codex.js';

const temporary = await mkdtemp(path.join(tmpdir(), 'frameboard-browser-'));
// Stand-in for YouTube so the checks run offline.
const fakeYoutube = async (url) => url.startsWith('https://www.youtube.com/oembed')
  ? new Response(JSON.stringify({ title: 'A borrowed idea' }))
  : new Response(Buffer.from([255, 216, 255, 224, 0, 16]));
const codex = new ControlledCodex(path.join(temporary, 'data'));
const claude = new ControlledCodex(path.join(temporary, 'data')); claude.models = ['sonnet', 'opus'];
const server = await createApp({ dataDir: path.join(temporary, 'data'), fetch: fakeYoutube, codexAdapter: codex, claudeAdapter: claude });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(process.env.CHROME_PATH || 'chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'chrome')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const pending = new Map();
const browserErrors = [];
let sequence = 0;
let sessionId;
let interceptedDrag;
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
    if (message.method === 'Input.dragIntercepted') interceptedDrag = message.params.data;
    if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params.exceptionDetails);
    if (message.id) {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      clearTimeout(handler.timer);
      if (message.error) handler.reject(new Error(message.error.message)); else handler.resolve(message.result);
    }
  };
  const send = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chromium command timed out: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
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
  const drag = async (sourceSelector, targetSelector, expectedId, placement = 'before') => {
    const points = await evaluate(`(() => {
      const source = document.querySelector(${JSON.stringify(sourceSelector)});
      const target = document.querySelector(${JSON.stringify(targetSelector)});
      source.scrollIntoView({ block: 'center', inline: 'nearest' });
      const a = source.getBoundingClientRect(), b = target.getBoundingClientRect();
      const placement = ${JSON.stringify(placement)};
      const siblings = Array.from(target.parentElement.querySelectorAll('[data-card]')).filter(card => card.dataset.card !== ${JSON.stringify(expectedId)});
      const next = siblings[siblings.indexOf(target) + 1];
      const last = target.querySelector('.card:last-child');
      return {
        x1: a.left + a.width / 2, y1: a.top + a.height / 2, x2: b.left + b.width / 2,
        y2: target.matches('.card') ? b.top + b.height * (placement === 'after' ? .75 : .25) : placement === 'end' ? Math.max(b.top + 70, (last?.getBoundingClientRect().bottom || b.top) + 20) : Math.max(b.top + 70, a.top + a.height / 2),
        beforeId: target.matches('.card') ? placement === 'after' ? next?.dataset.card || null : target.dataset.card : null,
      };
    })()`);
    interceptedDrag = null;
    await send('Input.setInterceptDrags', { enabled: true });
    try {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x1, y: points.y1 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.x1, y: points.y1, button: 'left', clickCount: 1 });
      for (let step = 1; step <= 5; step++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.x1 + (points.x2 - points.x1) * step / 5, y: points.y1 + (points.y2 - points.y1) * step / 5, button: 'left', buttons: 1 });
      }
      for (let attempt = 0; attempt < 30 && !interceptedDrag; attempt++) await pause(20);
      assert.ok(interceptedDrag, 'Dragging from the card starts a native drag');
      assert.equal(interceptedDrag.items.find((item) => item.mimeType === 'text/plain')?.data, expectedId, 'Dragging the image carries the card ID');
      assert.equal(interceptedDrag.items.some((item) => item.mimeType === 'text/uri-list'), false, 'Dragging a card must not start a separate image URL drag');
      for (const type of ['dragEnter', 'dragOver']) await send('Input.dispatchDragEvent', { type, x: points.x2, y: points.y2, data: interceptedDrag });
      const motion = await evaluate(`(() => {
        const slot = document.querySelector('.drop-indicator');
        return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, animations: slot?.getAnimations({ subtree: true }).length || 0 };
      })()`);
      if (motion.reduced) assert.equal(motion.animations, 0, 'Reduced motion keeps the insertion preview still');
      else assert.equal(motion.animations, 2, 'The gap slides open and the line grows');
      await evaluate(`Promise.all(document.querySelector('.drop-indicator').getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))`);
      const indicator = await evaluate(`(() => {
        const slots = document.querySelectorAll('.drop-indicator');
        const slot = slots[0];
        return { count: slots.length, height: slot?.getBoundingClientRect().height, lineHeight: slot?.querySelector('span').getBoundingClientRect().height, beforeId: slot?.nextElementSibling?.dataset.card || null };
      })()`);
      assert.equal(indicator.count, 1, 'One insertion line shows the active drop position');
      assert.ok(indicator.height >= 26, 'The insertion line gets its own gap between cards');
      assert.equal(indicator.lineHeight, 2);
      assert.equal(indicator.beforeId, points.beforeId, 'The insertion gap matches the intended position');
      await send('Input.dispatchDragEvent', { type: 'drop', x: points.x2, y: points.y2, data: interceptedDrag });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.x2, y: points.y2, button: 'left', clickCount: 1 });
      assert.equal(await evaluate(`document.querySelectorAll('.drop-indicator').length`), 0, 'The insertion line clears after dropping');
      await evaluate(`Promise.all(document.querySelector('#board').getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))`);
    } finally { await send('Input.setInterceptDrags', { enabled: false }); }
  };
  // The editor doesn't show Prompt; it is set through Set prompt, lane commands, or card state.
  const openCardPrompt = () => evaluate(`(async () => (await import('/state.js')).locateCard().card.fields.prompt)()`);
  const setOpenCardPrompt = (value) => evaluate(`(async () => { const { locateCard, cardChanged } = await import('/state.js'); const card = locateCard().card; card.fields.prompt = ${JSON.stringify(value)}; cardChanged(card); })()`);
  const saved = () => waitFor(`document.querySelector('[data-save-status]')?.textContent.includes('All changes saved')`);
  const snapshot = async (name) => {
    await evaluate(`Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))`);
    await mkdir('test-results', { recursive: true });
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`test-results/${name}.png`, Buffer.from(data, 'base64'));
  };
  // Rebuilds the nested projects → lanes → cards shape from the API for easy assertions.
  const state = async () => {
    const workspace = await (await fetch(`${base}/api/workspace`)).json();
    return { projects: await Promise.all(workspace.projects.map(async (project) => {
      const { cards } = await (await fetch(`${base}/api/projects/${project.id}/cards`)).json();
      const { stages } = workspace.flows.find((flow) => flow.id === project.flowId);
      return { ...project, lanes: stages.map((stage) => ({ ...stage, cards: cards.filter((card) => card.stageId === stage.id) })) };
    })) };
  };
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
  assert.equal((await state()).projects[0].lanes[0].cards[0].fields.originalVideoUrl, 'unfinished');
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
  assert.equal(edited.fields.titleOptions, 'Before the city wakes\nSmall rituals');
  assert.equal(edited.fields.originalVideoTitle, 'A study in stillness');
  assert.equal(edited.fields.originalVideoUrl, `${base}/?video=original&reference=1`);
  assert.equal(edited.fields.publishedVideoUrl, `${base}/?video=published`);
  assert.equal(edited.images.length, 2);
  assert.equal(edited.imageRoles.cover, edited.images[1].id);
  assert.ok(Date.parse(edited.updatedAt) > Date.parse(createdTimestamp));
  assert.equal(await evaluate(`document.querySelector('#card-dialog .edited-at time').dateTime`), edited.updatedAt);
  await click('.image-tile.is-display [data-action="set-display"]');
  assert.equal(await evaluate(`document.querySelector('#card-dialog .edited-at time').dateTime`), edited.updatedAt);
  console.log('PASS card text, multiple uploads, display image, autosave');

  // Exercise actual clipboard paste through Chromium, not just the file picker.
  await send('Browser.grantPermissions', { origin: base, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }, null);
  await setOpenCardPrompt('Compare the original and inspiration.\nSuggest a stronger hook.');
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
  for (const [input, key] of [['card-intro', 'intro'], ['card-title-options', 'titleOptions'], ['card-script', 'script'], ['card-original-video-title', 'originalVideoTitle'], ['card-original-video-url', 'originalVideoUrl'], ['card-published-video-url', 'publishedVideoUrl']]) {
    assert.equal(await evaluate(`document.querySelector('#${input}').value`), edited.fields[key]);
  }
  assert.equal(await evaluate(`document.querySelector('#card-original-video-url-link a').href`), edited.fields.originalVideoUrl);
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
  await drag('.card-image img', `[data-lane="${lanes[2].id}"]`, lanes[1].cards[0].id);
  await saved();
  assert.equal((await state()).projects[0].lanes[2].cards.length, 1);
  assert.equal(await evaluate(`document.querySelector('#card-dialog').open`), false, 'Dragging does not also open the editor');
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

  // A tall lane must leave neighbouring lanes droppable at the same depth.
  const tallCards = await evaluate(`(async () => {
    const { project, createCard, cardChanged, flushCards } = await import('/state.js');
    const { renderBoard } = await import('/board.js');
    const lane = project().lanes[0], original = lane.cards[0];
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const card = createCard(lane);
      card.title = 'Tall lane card ' + i;
      card.images = structuredClone(original.images);
      card.imageRoles = structuredClone(original.imageRoles);
      cardChanged(card); ids.push(card.id);
    }
    flushCards(); renderBoard(); return ids;
  })()`);
  await saved();
  const laneHeights = await evaluate(`Array.from(document.querySelectorAll('.lane'), lane => lane.getBoundingClientRect().height)`);
  assert.ok(laneHeights[0] > 1000, 'Fixture makes a lane taller than the viewport');
  assert.ok(laneHeights.every((height) => Math.abs(height - laneHeights[0]) < 1), 'Short and empty lanes stretch to the tallest lane');
  const lastTallCard = tallCards.at(-1);
  await drag(`[data-card="${lastTallCard}"] .card-image img`, `[data-lane="${lanes[1].id}"]`, lastTallCard);
  await saved();
  assert.ok((await state()).projects[0].lanes[1].cards.some((card) => card.id === lastTallCard), 'Image drag drops into the empty space near the bottom of a short lane');
  assert.equal(await evaluate(`document.querySelector('#card-dialog').open`), false);
  console.log('PASS tall lanes share full-height drop targets and accept image drags near the bottom');

  await click('[data-action="toggle-cards"]');
  assert.equal(await evaluate(`document.querySelector('[data-action="toggle-cards"]').textContent`), 'Expand cards');
  assert.equal(await evaluate(`document.querySelector('[data-action="toggle-cards"]').getAttribute('aria-pressed')`), 'true');
  assert.equal(await evaluate(`document.querySelectorAll('.card-image, .card-meta, .card-body > p, .card-body > .edited-at').length`), 0);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.card'), card => card.getBoundingClientRect().height).every(height => height < 60)`));
  await evaluate(`document.querySelector('#board').scrollLeft = 0; window.scrollTo(0, 0)`);
  await drag(`[data-card="${tallCards[1]}"] h3`, `[data-card="${tallCards[0]}"]`, tallCards[1]);
  await saved();
  const compactOrder = (await state()).projects[0].lanes[0].cards.map((card) => card.id);
  assert.ok(compactOrder.indexOf(tallCards[1]) < compactOrder.indexOf(tallCards[0]), 'Titles-only cards still reorder with a native drag');
  await drag(`[data-card="${tallCards[1]}"] h3`, `[data-card="${tallCards[0]}"]`, tallCards[1], 'after');
  await saved();
  const afterOrder = (await state()).projects[0].lanes[0].cards.map((card) => card.id);
  assert.ok(afterOrder.indexOf(tallCards[1]) > afterOrder.indexOf(tallCards[0]), 'Dropping in the lower half inserts after the target card');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await drag(`[data-card="${tallCards[0]}"] h3`, `[data-lane="${lanes[0].id}"]`, tallCards[0], 'end');
  await send('Emulation.setEmulatedMedia', { features: [] });
  await saved();
  assert.equal((await state()).projects[0].lanes[0].cards.at(-1).id, tallCards[0], 'The end-of-lane insertion line appends the card');
  await fill('#search', 'kettle');
  assert.equal(await evaluate(`document.querySelectorAll('.card').length`), 1, 'Collapsed cards still search their hidden fields');
  await fill('#search', '');
  await click(`[data-card="${tallCards[0]}"] [data-action="open-card"]`);
  assert.equal(await evaluate(`document.querySelector('#card-dialog').open`), true);
  assert.equal(await evaluate(`document.querySelector('#card-title').value`), 'Tall lane card 0');
  await click('#card-dialog [data-action="close-card"]');
  await waitFor(`!document.querySelector('#card-dialog').open`);
  await saved(); // Closing now persists the editing-session boundary.
  // The panel overlays the board: Escape and clicking off it both close it.
  await click(`[data-card="${tallCards[0]}"] [data-action="open-card"]`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`!document.querySelector('#card-dialog').open`);
  await click(`[data-card="${tallCards[0]}"] [data-action="open-card"]`);
  const outside = await evaluate(`(() => { const box = document.querySelector('.board-header h1').getBoundingClientRect(); return { x: box.left + 10, y: box.top + box.height / 2 }; })()`);
  assert.ok(outside.x < await evaluate(`document.querySelector('#card-dialog').getBoundingClientRect().left`), 'The board stays visible beside the panel');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...outside, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...outside, button: 'left', clickCount: 1 });
  await waitFor(`!document.querySelector('#card-dialog').open`);
  await saved();
  await evaluate(`window.beforeCompactReload = true`);
  await send('Page.reload');
  await waitFor(`!window.beforeCompactReload && document.querySelector('#board')?.classList.contains('cards-collapsed')`);
  assert.equal(await evaluate(`document.querySelectorAll('.card-image').length`), 0, 'Collapsed display preference survives reload');
  await snapshot('collapsed-board');
  await click('[data-action="toggle-cards"]');
  assert.ok(await evaluate(`document.querySelectorAll('.card-image').length > 0`));
  await evaluate(`(async () => {
    const { deleteCard } = await import('/state.js');
    for (const id of ${JSON.stringify(tallCards)}) deleteCard(id);
    (await import('/board.js')).renderBoard();
    window.scrollTo(0, 0);
  })()`);
  await saved();
  assert.equal((await state()).projects[0].lanes.reduce((sum, lane) => sum + lane.cards.length, 0), 2);
  console.log('PASS titles-only cards open, reorder, search, close on Escape or click-off, and remember their display preference');

  await click('.header-actions [data-action="add-lane"]');
  await fill('#name-input', 'Published');
  const entryPrompt = 'Review this card’s script.\nSuggest a stronger opening.';
  assert.equal(await evaluate(`document.querySelectorAll('input[name="color"]').length`), 12);
  await click('input[name="color"][value="teal"]');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects[0].lanes.length, 5);
  const addedLane = (await state()).projects[0].lanes.at(-1).id;
  assert.equal((await state()).projects[0].lanes.at(-1).color, 'teal');
  assert.ok(await evaluate(`document.querySelector('[data-lane="${addedLane}"] .lane-dot').classList.contains('teal')`));
  // A lane playbook is a Markdown file; its set: values apply on entry.
  await click(`[data-action="edit-playbook"][data-id="${addedLane}"]`);
  await waitFor(`document.querySelector('#playbook-dialog').open && document.querySelector('.playbook-empty')`);
  await click('[data-playbook-action="create-lane"]');
  await waitFor(`document.querySelector('#playbook-text')?.value.includes('lane: ${addedLane}')`);
  const playbookText = `---
lane: ${addedLane}
run: off
set:
  prompt: |-
    Review this card’s script.
    Suggest a stronger opening.
  originalVideoTitle: An inspiration set in the same node
  script: A script set in the same node
  intro: An introduction from the lane
  title: Ready for review
---

# Published

These values apply when a card enters this lane.
`;
  await fill('#playbook-text', playbookText.replace('run: off', 'run: off\nmay_edit: [nope]'));
  await waitFor(`document.querySelector('.playbook-problems')?.textContent.includes('nope')`);
  await fill('#playbook-text', playbookText);
  await waitFor(`!document.querySelector('.playbook-problems') && document.querySelector('.playbook-inspector h3').textContent.includes('sets Prompt')`);
  assert.equal(await evaluate(`document.querySelector('#playbook-status').textContent`), 'Unsaved changes · Ctrl+S saves');
  await snapshot('lane-playbook-editor');
  await click('[data-playbook-action="save"]');
  await waitFor(`document.querySelector('#playbook-status').textContent.startsWith('Saved')`);
  await click('[data-playbook-action="close"]');
  await waitFor(`!document.querySelector('#playbook-dialog').open`);
  await saved();
  assert.match((await state()).projects[0].lanes.at(-1).playbook.summary, /sets Prompt, Original video title, Script, Intro, Card title/);
  await click(`[data-action="edit-lane"][data-id="${addedLane}"]`);
  await fill('#name-input', 'Archived');
  await click('input[name="color"][value="purple"]');
  await select('#lane-position', '0');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects[0].lanes[0].name, 'Archived');
  assert.equal((await state()).projects[0].lanes[0].color, 'purple');
  // The prompt updates while the card editor stays open, and later edits save.
  await click('[data-action="open-card"]');
  const entryCardId = await evaluate(`(async () => (await import('/state.js')).state.cardId)()`);
  const entrySourceLane = await evaluate(`document.querySelector('#card-lane').value`);
  const entryBefore = await evaluate(`(async () => { const { locateCard } = await import('/state.js'); const card = locateCard().card; return { title: card.title, fields: { ...card.fields } }; })()`);
  await select('#card-lane', addedLane);
  await saved();
  assert.equal(await openCardPrompt(), entryPrompt);
  assert.equal(await evaluate(`document.querySelector('#card-intro').value`), 'An introduction from the lane');
  assert.equal(await evaluate(`document.querySelector('#card-title').value`), 'Ready for review');
  assert.equal(await evaluate(`document.querySelector('#card-original-video-title').value`), 'An inspiration set in the same node');
  assert.equal(await evaluate(`document.querySelector('#card-script').value`), 'A script set in the same node');
  await click('#card-dialog [data-action="undo-move"]');
  await saved();
  assert.equal(await evaluate(`document.querySelector('#card-lane').value`), entrySourceLane);
  assert.equal(await evaluate(`document.querySelector('#card-title').value`), entryBefore.title);
  assert.equal(await openCardPrompt(), entryBefore.fields.prompt);
  assert.equal(await evaluate(`document.querySelector('#card-intro').value`), entryBefore.fields.intro);
  assert.equal(await evaluate(`document.querySelector('#card-script').value`), entryBefore.fields.script);
  assert.equal(await evaluate(`document.querySelector('#card-dialog [data-action="undo-move"]').disabled`), true);
  await select('#card-lane', addedLane);
  await saved();
  await setOpenCardPrompt('My prompt after entering');
  await saved();
  await select('#card-lane', entrySourceLane);
  await click('#card-dialog [data-action="close-card"]');
  await waitFor(`!document.querySelector('#card-dialog').open`); // Closing animates before the board settles.
  await saved();
  await drag(`[data-card="${entryCardId}"] h3`, `[data-lane="${addedLane}"]`, entryCardId);
  await saved();
  assert.equal((await state()).projects[0].lanes[0].cards[0].fields.prompt, entryPrompt, 'Dragging into the lane also replaces the prompt');
  await send('Page.reload');
  await waitFor(`document.querySelector('[data-action="open-card"][data-id="${entryCardId}"]')`);
  await saved();
  assert.equal(await evaluate(`document.querySelector('[data-undo-move="board"]').disabled`), false, 'Undo survives reloading');
  await click('[data-undo-move="board"]');
  await saved();
  assert.equal((await state()).projects[0].lanes.find(lane => lane.id === entrySourceLane).cards.find(card => card.id === entryCardId).fields.prompt, 'My prompt after entering');
  await drag(`[data-card="${entryCardId}"] h3`, `[data-lane="${addedLane}"]`, entryCardId);
  await saved();
  console.log('PASS editor and board undo restore lane playbook fields, including after reload');

  await click(`[data-action="open-card"][data-id="${entryCardId}"]`);
  await select('#card-lane', entrySourceLane);
  await click('#card-dialog [data-action="close-card"]');
  await saved();
  await click(`[data-lane="${addedLane}"] .lane-actions [data-action="add-card"]`);
  await saved();
  assert.equal(await openCardPrompt(), entryPrompt, 'Cards created in the lane start with its prompt');
  await click('#card-dialog [data-action="close-card"]');
  // Closing with a draft asks first; discarding keeps the saved file.
  await click(`[data-action="edit-playbook"][data-id="${addedLane}"]`);
  await waitFor(`document.querySelector('#playbook-dialog').open && document.querySelector('#playbook-text')?.value.includes('Ready for review')`);
  const beforeSlowSave = await evaluate(`document.querySelector('#playbook-text').value`);
  const submittedPlaybook = `${beforeSlowSave}\nSaved during the slow request.`;
  const newerPlaybook = `${submittedPlaybook}\nTyped while saving.`;
  await evaluate(`(() => {
    const originalFetch = window.fetch;
    window.restorePlaybookFetch = () => { window.fetch = originalFetch; };
    window.fetch = async (url, options) => {
      if (options?.method === 'PUT' && String(url).includes('/playbooks')) {
        window.fetch = originalFetch;
        const response = await originalFetch(url, options);
        await new Promise(resolve => { window.releasePlaybookSave = resolve; });
        return response;
      }
      return originalFetch(url, options);
    };
  })()`);
  await fill('#playbook-text', submittedPlaybook);
  await click('[data-playbook-action="save"]');
  await waitFor(`typeof window.releasePlaybookSave === 'function'`);
  await fill('#playbook-text', newerPlaybook);
  await evaluate(`document.querySelector('#playbook-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
  assert.ok(await evaluate(`document.querySelector('#playbook-dialog').open && !document.querySelector('#form-dialog').open`), 'A pending save keeps the editor session open');
  await evaluate(`window.releasePlaybookSave()`);
  await pause(250);
  assert.equal(await evaluate(`document.querySelector('#playbook-text').value`), newerPlaybook, 'Typing while saving preserves the newer Markdown draft');
  assert.ok(await evaluate(`document.querySelector('#playbook-status').textContent.includes('Unsaved')`));
  await click('[data-playbook-action="save"]');
  await waitFor(`document.querySelector('#playbook-status').textContent.startsWith('Saved')`);
  await evaluate(`window.restorePlaybookFetch(); delete window.restorePlaybookFetch; delete window.releasePlaybookSave;`);
  console.log('PASS Markdown edits typed during a slow playbook save remain unsaved and can be saved next');
  await fill('#playbook-text', 'A draft to discard');
  await click('[data-playbook-action="close"]');
  await waitFor(`document.querySelector('#form-dialog').open`);
  await click('#small-form [type="submit"]');
  await waitFor(`!document.querySelector('#playbook-dialog').open`);
  await click(`[data-action="edit-playbook"][data-id="${addedLane}"]`);
  await waitFor(`document.querySelector('#playbook-dialog').open && document.querySelector('#playbook-text')?.value.includes('Ready for review')`);

  // An agent lane: instructions, a shared skill and may_edit. Entering the
  // lane sends the map, playbook, skill and notes; the result comes back.
  await click('[data-playbook-action="new-skill"]');
  await waitFor(`document.querySelector('#skill-name')`);
  await fill('#skill-name', 'voice');
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelector('#playbook-heading').textContent === 'Skill · voice'`);
  await fill('#playbook-text', '# Voice\n\nWarm and direct.');
  await click('[data-playbook-action="save"]');
  await waitFor(`document.querySelector('#playbook-status').textContent.startsWith('Saved')`);
  await click(`[data-playbook-action="select"][data-id="${addedLane}"]`);
  await fill('#playbook-text', `---\nlane: ${addedLane}\nmodel: test-model\nmay_edit: [intro]\n---\n\nWrite a better intro. Follow skills/voice.md.\n`);
  await waitFor(`document.querySelector('.playbook-inspector h3').textContent === 'Runs on entry · Card chat provider · may edit Intro'`);
  await click('[data-playbook-action="save"]');
  await waitFor(`document.querySelector('#playbook-status').textContent.startsWith('Saved')`);
  await click('[data-playbook-action="close"]');
  await waitFor(`!document.querySelector('#playbook-dialog').open`);
  assert.equal(await evaluate(`document.querySelector('[data-lane="${addedLane}"] .lane-playbook-badge').textContent`), 'Auto');
  await click(`[data-action="open-card"][data-id="${entryCardId}"]`);
  await waitFor(`document.querySelector('#card-playbook strong')`);
  const sendsBefore = codex.sends.length;
  await select('#card-lane', addedLane);
  await saved();
  await waitFor(`document.querySelector('#card-playbook strong').textContent === 'Archived playbook'`);
  for (let attempt = 0; codex.sends.length === sendsBefore && attempt < 100; attempt++) await pause(50);
  const laneSend = codex.sends.at(-1);
  assert.ok(laneSend.input[0].text.includes('Warm and direct.'), 'The lane run includes its skill');
  codex.finish(laneSend, 'completed', 'Here it is.\n\n```frameboard-result\n{"fields": {"intro": "A lane-written intro"}, "notes": "Wrote the intro in the voice guide.", "outputs": [{"filename": "intro-notes.md", "text": "Why this intro works."}]}\n```');
  await waitFor(`document.querySelector('#card-intro').value === 'A lane-written intro'`);
  await waitFor(`document.querySelector('#lane-notes').value.includes('Wrote the intro in the voice guide.')`);
  await waitFor(`document.querySelector('.card-playbook-run')?.textContent.includes('Applied Intro')`);
  await waitFor(`document.querySelector('.chat-lane-run')?.textContent.includes('Archived playbook')`);
  // The lane's declared document and a user's Save as document sit beside the run.
  await waitFor(`document.querySelector('.chat-saved-outputs')?.textContent.includes('intro-notes.md')`);
  assert.ok(await evaluate(`Boolean(document.querySelector('.chat-saved-outputs a[download]'))`), 'A saved document can be downloaded');
  await evaluate(`(() => { const range = document.createRange(); range.selectNodeContents([...document.querySelectorAll('.chat-reply-text')].at(-1)); getSelection().removeAllRanges(); getSelection().addRange(range); })()`);
  await waitFor(`!document.querySelector('#chat-selection-actions').hidden`);
  await click('[data-action="chat-save-selection"]');
  await waitFor(`document.querySelector('#form-dialog').open && document.querySelector('#form-heading')?.textContent === 'Save as document'`);
  await fill('#chat-document-name', 'lane-reply.md');
  await click('#small-form button[type="submit"]');
  await waitFor(`document.querySelectorAll('.chat-saved-outputs li').length === 2 && document.querySelector('.chat-saved-outputs').textContent.includes('lane-reply.md')`);
  console.log('PASS lane result documents and Save as document appear beside the run with downloads');
  // Save output keeps one named workspace file the response wrote.
  const renders = path.join(temporary, 'data', 'workspaces', entryCardId, 'renders');
  await mkdir(renders, { recursive: true });
  await writeFile(path.join(renders, 'frame.bin'), Buffer.from([0, 1, 2, 255]));
  await evaluate(`[...document.querySelectorAll('[data-action="chat-save-file"]')].at(-1).click()`);
  await waitFor(`document.querySelector('#form-dialog').open && document.querySelector('#form-heading')?.textContent === 'Save output from the workspace'`);
  await fill('#chat-file-path', 'renders/frame.bin');
  await click('#small-form button[type="submit"]');
  await waitFor(`[...document.querySelectorAll('.chat-saved-outputs li')].some((li) => li.textContent.includes('frame.bin') && li.textContent.includes('Saved by you from the workspace') && li.querySelector('a[download]'))`);
  console.log('PASS Save output keeps a named workspace file beside its response');
  // Save to project library publishes a separate Library file; a second save of the same name asks Create new, Replace or Cancel.
  const entryProjectId = (await (await fetch(`${base}/api/cards/${entryCardId}`)).json()).card.projectId;
  const promotedFiles = async () => (await (await fetch(`${base}/api/projects/${entryProjectId}/library`)).json()).assets
    .filter((asset) => asset.promotedFrom).map((asset) => [asset.filename, asset.versionCount]);
  await click('.chat-saved-outputs [data-action="chat-promote-output"]');
  await waitFor(`document.querySelector('#form-dialog').open && document.querySelector('#form-heading')?.textContent === 'Save intro-notes.md to the project Library' && document.querySelector('#name-input').value === 'intro-notes.md'`);
  await click('#small-form button[type="submit"]');
  await waitFor(`document.querySelector('.chat-saved-outputs')?.textContent.includes('Saved to Library as intro-notes.md')`);
  assert.deepEqual(await promotedFiles(), [['intro-notes.md', 1]]);
  await click('.chat-saved-outputs [data-action="chat-promote-output"]');
  await waitFor(`document.querySelector('#form-dialog').open && document.querySelector('#form-heading')?.textContent === 'Save intro-notes.md to the project Library'`);
  await click('#small-form button[type="submit"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'A file named intro-notes.md already exists'`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('input[name="collision"]')].map(input => input.value)`), ['create', 'replace', 'cancel']);
  assert.equal(await evaluate(`document.querySelector('input[name="collision"]:checked').value`), 'create', 'Create new is the default');
  await evaluate(`document.querySelector('input[name="collision"][value="replace"]').checked = true`);
  await click('#small-form button[type="submit"]');
  await waitFor(`document.querySelector('.chat-saved-outputs')?.textContent.includes('Replaced intro-notes.md')`);
  assert.deepEqual(await promotedFiles(), [['intro-notes.md', 2]]);
  // Later checks start from an empty Library; removal keeps the saved output.
  for (const asset of (await (await fetch(`${base}/api/projects/${entryProjectId}/library`)).json()).assets) await fetch(`${base}/api/projects/${entryProjectId}/library/assets/${asset.id}`, { method: 'DELETE' });
  console.log('PASS Save to project library creates a Library file, then asks Create new, Replace or Cancel and replaces with a new version');
  await snapshot('lane-run-result');
  // Use in prompt sends the saved document's exact version with the next manual prompt.
  const reuseButton = `.chat-saved-outputs li:last-child [data-action="chat-reuse-output"]`;
  await click(reuseButton);
  await waitFor(`document.querySelector('${reuseButton}')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#chat-composer').textContent.includes('Saved outputs')`);
  await waitFor(`document.querySelector('[aria-label="Reused saved outputs"]')?.textContent.includes('lane-reply.md')`);
  await select('#chat-model', 'test-model');
  await fill('#chat-prompt', 'Shorten the saved reply');
  const sendsBeforeReuse = codex.sends.length;
  await click('[data-action="chat-send"]');
  for (let attempt = 0; codex.sends.length === sendsBeforeReuse && attempt < 100; attempt++) await pause(50);
  const reuseSend = codex.sends.at(-1);
  assert.ok(reuseSend.input[0].text.includes('Reused saved outputs from this card chat') && reuseSend.input[0].text.includes('lane-reply.md'), 'The saved document is sent as reference material');
  codex.finish(reuseSend, 'completed', 'Shorter.');
  await waitFor(`[...document.querySelectorAll('.chat-delivery')].some((list) => list.textContent.includes('lane-reply.md · full text inline · sent'))`);
  console.log('PASS Use in prompt reuses a saved document in the next prompt and records its delivery');
  // A conflicting notes draft survives switching cards, then can be resolved.
  await fill('#lane-notes', 'My conflicting hand-off');
  const storedNotes = await (await fetch(`${base}/api/cards/${entryCardId}/notes`)).json();
  await fetch(`${base}/api/cards/${entryCardId}/notes`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Notes from another editor', baseHash: storedNotes.hash }) });
  await waitFor(`!document.querySelector('#lane-notes-conflict').hidden`);
  const otherNotesCard = (await state()).projects[0].lanes.flatMap((lane) => lane.cards).find((card) => card.id !== entryCardId);
  await evaluate(`import('/editor.js').then(({ openCard }) => openCard(${JSON.stringify(otherNotesCard.id)}))`);
  await waitFor(`!document.querySelector('#lane-notes').disabled`);
  await evaluate(`import('/editor.js').then(({ openCard }) => openCard(${JSON.stringify(entryCardId)}))`);
  await waitFor(`document.querySelector('#lane-notes').value === 'My conflicting hand-off' && !document.querySelector('#lane-notes-conflict').hidden`);
  await click('[data-action="notes-keep-mine"]');
  await waitFor(`document.querySelector('#lane-notes-conflict').hidden && document.querySelector('#lane-notes-state').textContent === ''`);
  assert.equal((await (await fetch(`${base}/api/cards/${entryCardId}/notes`)).json()).text, 'My conflicting hand-off');
  console.log('PASS conflicting hand-off notes survive card switches and resolve without losing the draft');
  // A queued failure explains both ways on: Retry in the card chat resends
  // the frozen run, Run playbook starts new work from what is saved now.
  const waitForSend = async (count) => { for (let attempt = 0; codex.sends.length < count && attempt < 100; attempt++) await pause(50); assert.equal(codex.sends.length, count); };
  const sendsBeforeFailure = codex.sends.length;
  await click('[data-action="run-playbook"]');
  await waitForSend(sendsBeforeFailure + 1);
  codex.finish(codex.sends.at(-1), 'failed', 'Provider failed');
  await waitFor(`document.querySelector('.card-playbook-guidance')?.textContent.includes("Retry in the card chat resends this run's original submission exactly as it was sent")`);
  await waitFor(`document.querySelectorAll('[data-action="chat-retry"]').length === 1 && document.querySelector('.chat-retry-hint')?.textContent.includes('Run playbook')`);
  await snapshot('lane-run-retry-guidance');
  await click('[data-action="chat-retry"]');
  await waitForSend(sendsBeforeFailure + 2);
  assert.equal(codex.sends.at(-1).input[0].text, codex.sends.at(-2).input[0].text, 'Retry resends the frozen lane run');
  codex.finish(codex.sends.at(-1), 'completed', 'No result this time.');
  await waitFor(`document.querySelector('.card-playbook-run')?.textContent.includes('Done') && !document.querySelector('.card-playbook-guidance') && !document.querySelector('[data-action="chat-retry"]')`);
  const guidance = (run, place) => evaluate(`import('/card-playbook.js').then(({ runGuidance }) => runGuidance(${JSON.stringify({ retryable: false, possiblyDelivered: false, conversationUncertain: false, submissionId: 'lane-run', ...run })}, ${JSON.stringify(place)}))`);
  assert.match(await guidance({ status: 'failed', submissionId: null }), /^Nothing was sent, so there is nothing to retry\. Fix the problem, then Run playbook/);
  assert.match(await guidance({ status: 'failed', submissionStatus: 'completed' }), /result was not applied\. Run playbook to start new work/);
  assert.match(await guidance({ status: 'queued', submissionStatus: 'uncertain', possiblyDelivered: true }), /may have received this run\. Check delivery in the card chat.*may repeat its work/);
  assert.match(await guidance({ status: 'failed', submissionStatus: 'interrupted', retryable: true, possiblyDelivered: true }), /resends this run's original submission exactly as it was sent.*may already have received it, so either may repeat its work/);
  assert.match(await guidance({ status: 'failed', submissionStatus: 'failed', conversationUncertain: true }), /^Another prompt's delivery in the card chat is uncertain\. Check delivery there first: Retry waits for it, and a new run queues behind it\.$/);
  assert.equal(await guidance({ status: 'failed', submissionStatus: 'failed' }), 'Run playbook starts a new run with the current playbook, inputs and notes.', 'a restored or archived run has no Retry to offer');
  assert.match(await guidance({ status: 'failed', submissionStatus: 'failed', retryable: true }, { here: false }), /^Retry in the card chat resends that run's original submission; its field changes become proposals\. Run playbook runs this lane's playbook instead\.$/);
  assert.equal(await guidance({ status: 'failed', submissionId: null }, { here: false }), '', 'Run playbook here would not rerun a run from another lane');
  assert.equal(await guidance({ status: 'completed', submissionStatus: 'completed' }), '');
  console.log('PASS a failed lane run explains Retry of the frozen run versus Run playbook, and history offers Retry only where it is accepted');
  // The card chat checks below count native threads and sends from zero.
  codex.threads.clear(); codex.sends.length = 0;
  await select('#card-lane', entrySourceLane);
  await click('#card-dialog [data-action="close-card"]');
  await waitFor(`!document.querySelector('#card-dialog').open`);
  await saved();

  await click(`[data-action="edit-playbook"][data-id="${addedLane}"]`);
  await waitFor(`document.querySelector('#playbook-dialog').open && document.querySelector('#playbook-text')`);
  await click('[data-playbook-action="delete"]');
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelector('.playbook-empty')`);
  await click('[data-playbook-action="close"]');
  await waitFor(`!document.querySelector('#playbook-dialog').open`);
  assert.equal((await state()).projects[0].lanes[0].playbook, null, 'Deleting the playbook leaves the lane without one');
  await click(`[data-action="edit-lane"][data-id="${addedLane}"]`);
  console.log('PASS lane playbooks: validation, set on entry, skills, an agent lane run with its result and notes, discard and delete');
  await click('[data-action="delete-lane"]');
  await click('#small-form [type="submit"]');
  await saved();
  assert.equal((await state()).projects[0].lanes.length, 4);
  console.log('PASS lane creation, editing, reordering, deletion');

  await click('.sidebar-section [data-action="add-project"]');
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

  await click('[data-action="edit-project"]');
  await click('[data-action="archive-project"]');
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelector('.archived-badge')`);
  assert.ok(await evaluate(`document.querySelector('.archived-projects [data-action="switch-project"]').classList.contains('active')`), 'The archived project moves to the Archived group');
  assert.equal(await evaluate(`document.querySelectorAll('#board [data-action="add-card"], #board [data-action="edit-lane"], .header-actions [data-action="add-lane"]').length`), 0, 'An archived board offers no editing actions');
  assert.equal(await evaluate(`document.querySelector('.card').draggable`), false);
  await click('[data-action="open-card"]');
  await waitFor(`document.querySelector('#card-dialog.archived .archived-banner')`);
  assert.ok(await evaluate(`document.querySelector('#card-title').readOnly && document.querySelector('#card-lane').disabled`), 'Archived cards open read-only');
  assert.equal(await evaluate(`document.querySelector('#card-dialog [data-action="delete-card"]').checkVisibility()`), false);
  await snapshot('archived-card');
  await click('[data-action="close-card"]');
  await click('[data-action="unarchive-project"]');
  await waitFor(`!document.querySelector('.archived-badge') && document.querySelector('.header-actions [data-action="add-lane"]')`);
  assert.equal(await evaluate(`document.querySelectorAll('.archived-projects').length`), 0);
  console.log('PASS project archive and unarchive');

  // Library: batch upload, thumbnails, explicit collision choices, inspection and download.
  await click('[data-action="show-library"]');
  await waitFor(`document.querySelector('#library .library-empty')?.textContent.includes('No files yet')`);
  const pickLibraryFiles = (files) => evaluate(`(async () => {
    const made = [];
    for (const [name, kind, text] of ${JSON.stringify(files)}) {
      if (kind === 'png') {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = text; ctx.fillRect(0, 0, 320, 180);
        made.push(new File([await new Promise(resolve => canvas.toBlob(resolve))], name, { type: 'image/png' }));
      } else made.push(new File([kind === 'bytes' ? new Uint8Array([0, 255, 1, 254]) : text], name));
    }
    const transfer = new DataTransfer(); made.forEach(file => transfer.items.add(file));
    const input = document.querySelector('#library-files'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const libraryNames = () => evaluate(`[...document.querySelectorAll('.library-asset .library-name')].map(node => node.textContent)`);
  await pickLibraryFiles([['logo.png', 'png', '#7b6aa8'], ['script.md', 'text', '# Episode 12\nHook: the desk studio.'], ['opaque.bin', 'bytes']]);
  await waitFor(`document.querySelectorAll('.library-upload.saved').length === 3 && document.querySelectorAll('.library-asset').length === 3`);
  assert.deepEqual(await libraryNames(), ['logo.png', 'opaque.bin', 'script.md']);
  await waitFor(`document.querySelector('.library-thumb img')?.naturalWidth === 320`);
  assert.equal(await evaluate(`document.querySelectorAll('.library-thumb.file').length`), 2);

  await pickLibraryFiles([['logo.png', 'png', '#3c8b7d']]);
  await waitFor(`document.querySelector('#form-dialog').open && document.querySelector('#form-heading')?.textContent === 'A file named logo.png already exists'`);
  assert.equal(await evaluate(`document.querySelector('input[name="collision"]:checked').value`), 'create', 'Create new is the default');
  assert.match(await evaluate(`document.querySelector('#small-form').textContent`), /logo \(1\)\.png/);
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelectorAll('.library-asset').length === 4`);
  assert.deepEqual(await libraryNames(), ['logo (1).png', 'logo.png', 'opaque.bin', 'script.md']);
  await pickLibraryFiles([['logo.png', 'png', '#c7835a']]);
  await waitFor(`document.querySelector('#form-dialog').open && document.querySelector('#form-heading')?.textContent === 'A file named logo.png already exists'`);
  await click('input[name="collision"][value="replace"]');
  await click('#small-form [type="submit"]');
  await waitFor(`[...document.querySelectorAll('.library-upload-state')].some(node => node.textContent === 'Replaced · v2')`);
  await pickLibraryFiles([['opaque.bin', 'bytes']]);
  await waitFor(`document.querySelector('#form-dialog').open && document.querySelector('#form-heading')?.textContent === 'A file named opaque.bin already exists'`);
  await click('input[name="collision"][value="cancel"]');
  await click('#small-form [type="submit"]');
  await waitFor(`[...document.querySelectorAll('.library-upload-state')].some(node => node.textContent === 'Cancelled')`);
  assert.equal(await evaluate(`document.querySelectorAll('.library-asset').length`), 4);

  await click('.library-asset[aria-label="Inspect script.md"]');
  await waitFor(`document.querySelector('#library-preview pre')?.textContent.includes('Hook: the desk studio.')`);
  const downloaded = await evaluate(`fetch(document.querySelector('#library-dialog .library-actions a[download]').href).then(response => response.text())`);
  assert.equal(downloaded, '# Episode 12\nHook: the desk studio.');
  await click('[data-action="library-close"]');
  await click('.library-asset[aria-label="Inspect logo.png"]');
  await waitFor(`document.querySelectorAll('#library-dialog .library-version').length === 2 && document.querySelector('#library-preview img')?.naturalWidth === 320`);
  assert.match(await evaluate(`document.querySelector('#library-dialog .library-version').textContent`), /v2\s*Current/);
  await snapshot('library-inspector');
  await click('[data-action="library-close"]');
  await snapshot('library');

  // Write/paste a document: its draft survives reload but is not a Library file until Save.
  const draftState = () => evaluate(`document.querySelector('.library-draft-state')?.textContent ?? ''`);
  await click('[data-action="library-write"]');
  await waitFor(`document.querySelector('#library-draft-name')?.value === 'Untitled.md'`);
  await fill('#library-draft-name', 'Hook guide.md');
  await fill('#library-draft-text', '# Hooks\nOpen on the payoff.');
  await waitFor(`!document.querySelector('.library-draft-state').textContent.includes('Keeping draft')`);
  assert.match(await draftState(), /not in the Library until you save/);
  await snapshot('library-editor');
  await click('[data-action="library-close"]');
  await waitFor(`!!document.querySelector('.library-asset.draft[aria-label="Edit draft Hook guide.md"]')`);
  await evaluate('window.beforeReload = true');
  await send('Page.reload');
  await waitFor(`!window.beforeReload && !!document.querySelector('[data-action="show-library"]')`);
  await click('[data-action="show-library"]');
  await waitFor(`!!document.querySelector('.library-asset.draft[aria-label="Edit draft Hook guide.md"]')`);
  assert.deepEqual(await libraryNames(), ['Hook guide.md', 'logo (1).png', 'logo.png', 'opaque.bin', 'script.md']);
  await click('.library-asset.draft[aria-label="Edit draft Hook guide.md"]');
  await waitFor(`document.querySelector('#library-draft-text')?.value === '# Hooks\\nOpen on the payoff.'`);
  await click('[data-action="library-save-draft"]');
  await waitFor(`document.querySelector('#library-heading')?.textContent === 'Hook guide.md' && document.querySelector('#library-preview pre')?.textContent.includes('Open on the payoff.')`);
  assert.match(await evaluate(`document.querySelector('.library-preview-label').textContent`), /^Saved v1$/);
  assert.equal(await evaluate(`document.querySelectorAll('.library-asset.draft').length`), 0);

  // Editing keeps a draft; preview and download stay on the saved version until Save.
  await click('[data-action="library-edit"]');
  await waitFor(`!!document.querySelector('#library-draft-text') && !document.querySelector('#library-draft-name')`);
  await fill('#library-draft-text', '# Hooks\nOpen on the payoff. Then cut.');
  await waitFor(`!document.querySelector('.library-draft-state').textContent.includes('Keeping draft')`);
  assert.match(await draftState(), /use saved v1/);
  await click('[data-action="library-close"]');
  await waitFor(`[...document.querySelectorAll('.library-asset')].some(node => node.textContent.includes('Hook guide.md') && node.textContent.includes('Draft'))`);
  await click('.library-asset[aria-label="Inspect Hook guide.md"]');
  await waitFor(`document.querySelector('#library-preview pre')?.textContent === '# Hooks\\nOpen on the payoff.'`);
  assert.match(await evaluate(`document.querySelector('.library-preview-label').textContent`), /Saved v1 · Unsaved draft/);
  assert.equal(await evaluate(`fetch(document.querySelector('#library-dialog .library-actions a[download]').href).then(response => response.text())`), '# Hooks\nOpen on the payoff.');
  await click('[data-action="library-edit-draft"]');
  await waitFor(`document.querySelector('#library-draft-text')?.value.endsWith('Then cut.')`);
  await click('[data-action="library-save-draft"]');
  await waitFor(`document.querySelector('.library-preview-label')?.textContent === 'Saved v2' && document.querySelectorAll('#library-dialog .library-version').length === 2`);
  await click('[data-action="library-close"]');

  // A first save over a taken name asks Create new / Replace / Cancel.
  await click('[data-action="library-write"]');
  await waitFor(`!!document.querySelector('#library-draft-name')`);
  await fill('#library-draft-name', 'script.md');
  await fill('#library-draft-text', 'pasted notes');
  await click('[data-action="library-save-draft"]');
  await waitFor(`document.querySelector('#form-dialog').open && document.querySelector('#form-heading')?.textContent === 'A file named script.md already exists'`);
  assert.equal(await evaluate(`document.querySelector('input[name="collision"]:checked').value`), 'create');
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelector('#library-heading')?.textContent === 'script (1).md'`);
  await click('[data-action="library-close"]');
  await waitFor(`document.querySelectorAll('.library-asset').length === 6`);
  console.log('PASS Library documents keep drafts across reload, save explicit versions and keep saved content apart from drafts');

  // A lane playbook's Library selection: the picker and the Markdown edit one
  // draft, Save writes it whole, and the saved preview leaves the draft out.
  {
    const call = async (method, url, body) => (await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
    const board = (await state()).projects[0];
    const lane = board.lanes.find((entry) => !entry.playbook);
    const hook = (await call('GET', `/api/projects/${board.id}/library`)).assets.find((entry) => entry.filename === 'Hook guide.md');
    const previewCard = await call('POST', `/api/projects/${board.id}/cards`, { stageId: lane.id, title: 'Picker preview' });
    await send('Page.navigate', { url: base });
    await waitFor(`document.querySelectorAll('.lane').length >= 4 && !!document.querySelector('[data-action="edit-playbook"][data-id="${lane.id}"]')`);
    await click(`[data-action="edit-playbook"][data-id="${lane.id}"]`);
    await waitFor(`!!document.querySelector('[data-playbook-action="create-lane"]')`);
    await click('[data-playbook-action="create-lane"]');
    await waitFor(`document.querySelector('#playbook-text')?.value.includes('lane: ${lane.id}')`);
    const written = `---\nlane: ${lane.id}\nrun: off   # Quiet during checks\nmay_edit: []\n---\n# Picker lane\n\nMention Hook guide.md in prose; that alone sends nothing.\n`;
    await fill('#playbook-text', written);
    await waitFor(`document.querySelector('.playbook-inspector')?.textContent.includes('Library files') && !!document.querySelector('[data-playbook-action="add-assets"]')`);
    await click('[data-playbook-action="add-assets"]');
    await waitFor(`!!document.querySelector('#small-form input[value="asset:${hook.id}"]')`);
    await click(`#small-form input[value="asset:${hook.id}"]`);
    await click('#small-form [type="submit"]');
    const picked = written.replace('may_edit: []\n', `may_edit: []\nassets: [asset:${hook.id}]\n`);
    await waitFor(`document.querySelector('#playbook-text').value === ${JSON.stringify(picked)}`);
    await waitFor(`document.querySelector('.playbook-assets')?.textContent.includes('Hook guide.md')`);
    // Raw Markdown adds a source the Library does not have; it stays visible and saves.
    await fill('#playbook-text', picked.replace(`[asset:${hook.id}]`, `[asset:${hook.id}, asset:not-in-library]`));
    await waitFor(`document.querySelector('.playbook-assets')?.textContent.includes('Unresolved file') && document.querySelector('.playbook-assets').textContent.includes('asset:not-in-library')`);
    await snapshot('playbook-library-selection');
    await click('[data-playbook-action="save"]');
    await waitFor(`document.querySelector('#playbook-status').textContent.startsWith('Saved')`);
    const { lanes: documents } = await call('GET', `/api/flows/${board.flowId}/playbooks`);
    const file = path.join(temporary, 'data', 'flows', board.flowId, documents.find((entry) => entry.laneId === lane.id).path);
    assert.equal(await readFile(file, 'utf8'), picked.replace(`[asset:${hook.id}]`, `[asset:${hook.id}, asset:not-in-library]`), 'One save writes the new instructions and the selection together');
    // Another editor changes the file; the picker's removal stays a draft through the conflict.
    await appendFile(file, '\nEdited elsewhere.\n');
    await click('[data-playbook-action="remove-asset"][data-key="asset:not-in-library"]');
    await waitFor(`document.querySelector('#playbook-text').value === ${JSON.stringify(picked)}`);
    await click('[data-playbook-action="save"]');
    await waitFor(`document.querySelector('#playbook-status').textContent.includes('changed on disk')`);
    assert.equal(await evaluate(`document.querySelector('#playbook-text').value`), picked, 'A conflicting save keeps the draft');
    assert.match(await readFile(file, 'utf8'), /Edited elsewhere/);
    // The preview uses the newer saved file and marks the draft as left out.
    await select('#playbook-preview-card', previewCard.id);
    await click('[data-playbook-action="preview"]');
    await waitFor(`!!document.querySelector('.playbook-preview')`);
    assert.ok(await evaluate(`!!document.querySelector('.playbook-unsaved-note')`), 'The preview says unsaved changes are not in it');
    assert.match(await evaluate(`document.querySelector('.playbook-error').textContent`), /asset:not-in-library/);
    assert.ok(await evaluate(`document.querySelector('.playbook-preview-library').textContent.includes('Hook guide.md') && document.querySelector('.playbook-preview').textContent.includes('Edited elsewhere')`));
    await click('[data-playbook-action="close-preview"]');
    // Saving now deliberately replaces the newer file with the draft.
    await waitFor(`!!document.querySelector('[data-playbook-action="save"]:not([disabled])')`);
    await click('[data-playbook-action="save"]');
    await waitFor(`document.querySelector('#playbook-status').textContent.startsWith('Saved')`);
    assert.equal(await readFile(file, 'utf8'), picked);
    // With no draft, a preview of a file changed elsewhere says it is newer than the editor's copy.
    await writeFile(file, `${picked}Edited elsewhere again.\n`);
    await click('[data-playbook-action="preview"]');
    await waitFor(`!!document.querySelector('.playbook-preview')?.textContent.includes('Edited elsewhere again')`);
    assert.match(await evaluate(`document.querySelector('.playbook-unsaved-note')?.textContent ?? ''`), /changed on disk/);
    await click('[data-playbook-action="close-preview"]');
    assert.ok(await evaluate(`document.querySelector('#playbook-text').value.includes('Edited elsewhere again')`), 'The editor shows the newer file');
    await click('[data-playbook-action="delete"]');
    await waitFor(`document.querySelector('#form-dialog').open`);
    await click('#small-form [type="submit"]');
    await waitFor(`!document.querySelector('#form-dialog').open && !!document.querySelector('[data-playbook-action="create-lane"]')`);
    await click('[data-playbook-action="close"]');
    await waitFor(`!document.querySelector('#playbook-dialog').open`);
    await call('DELETE', `/api/cards/${previewCard.id}`);
    console.log('PASS the playbook Library picker and raw Markdown edit one draft; conflicts keep it and the saved preview leaves it out');
  }

  // Restore an older version as a new current one, then copy the file into another project.
  const json = async (method, url, body) => (await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  const { project: copies } = await json('POST', '/api/projects', { name: 'Copies' });
  const guides = await json('POST', `/api/projects/${copies.id}/library/folders`, { name: 'Guides' });
  await evaluate('window.beforeReload = true');
  await send('Page.reload');
  await waitFor(`!window.beforeReload && !!document.querySelector('[data-action="show-library"]')`);
  await click('[data-action="show-library"]');
  await waitFor(`!!document.querySelector('.library-asset[aria-label="Inspect Hook guide.md"]')`);
  await click('.library-asset[aria-label="Inspect Hook guide.md"]');
  await waitFor(`document.querySelectorAll('#library-dialog [data-action="library-restore"]').length === 1`);
  await click('#library-dialog [data-action="library-restore"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'Restore v1 of Hook guide.md?'`);
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelector('.library-preview-label')?.textContent === 'Saved v3' && document.querySelectorAll('#library-dialog .library-version').length === 3`);
  await waitFor(`document.querySelector('#library-preview pre')?.textContent === '# Hooks\\nOpen on the payoff.'`);
  assert.match(await evaluate(`document.querySelector('#library-dialog .library-version').textContent`), /v3\s*Current[\s\S]*restored from v1/);
  await click('[data-action="library-copy"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'Copy Hook guide.md to another project' && [...document.querySelectorAll('#library-copy-folder option')].some(option => option.textContent === 'Guides/')`);
  await evaluate(`document.querySelector('#library-copy-folder').value = ${JSON.stringify(guides.id)}`);
  await click('#small-form [type="submit"]');
  const copiedFiles = () => json('GET', `/api/projects/${copies.id}/library`).then(({ assets }) => assets.map((asset) => [asset.filename, asset.folderId, asset.versionCount]));
  await waitFor(`!document.querySelector('#form-dialog').open`);
  assert.deepEqual(await copiedFiles(), [['Hook guide.md', guides.id, 1]]);
  // A second copy with the same name offers Create new, never Replace.
  await click('[data-action="library-copy"]');
  await waitFor(`[...document.querySelectorAll('#library-copy-folder option')].some(option => option.textContent === 'Guides/')`);
  await evaluate(`document.querySelector('#library-copy-folder').value = ${JSON.stringify(guides.id)}`);
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'A file named Hook guide.md already exists'`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('input[name="collision"]')].map(input => input.value)`), ['create', 'cancel']);
  await click('#small-form [type="submit"]');
  for (let tries = 0; (await copiedFiles()).length < 2 && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await copiedFiles(), [['Hook guide (1).md', guides.id, 1], ['Hook guide.md', guides.id, 1]]);
  await click('[data-action="library-close"]');
  console.log('PASS Library restores an older version as a new current version and copies the current version into another project');

  // Folders: create one, drop a nested folder with per-file collisions, search
  // whole paths, rename and move without merging, and remove recursively.
  await evaluate(`document.querySelector('[data-action="library-clear-uploads"]')?.click()`);
  await click('[data-action="library-new-folder"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'New folder'`);
  await fill('#name-input', 'Thumbnails');
  await click('#small-form [type="submit"]');
  await waitFor(`!!document.querySelector('.library-folder[aria-label="Open folder Thumbnails"]')`);
  await click('.library-folder[aria-label="Open folder Thumbnails"]');
  await waitFor(`document.querySelector('.library-empty')?.textContent.includes('This folder is empty')`);
  // Directory entries as a browser's drop provides them, read by the app's own drop handler.
  const dropFolder = (tree) => evaluate(`(async () => {
    const { dropLibraryItems } = await import('/library.js');
    const entry = (name, node) => typeof node === 'string'
      ? { isFile: true, isDirectory: false, name, file: (resolve) => resolve(new File([node], name)) }
      : { isFile: false, isDirectory: true, name, createReader: () => { let read = false; return { readEntries: (resolve) => { resolve(read ? [] : Object.entries(node).map(([child, value]) => entry(child, value))); read = true; } }; } };
    dropLibraryItems({ items: Object.entries(${JSON.stringify(tree)}).map(([name, node]) => ({ webkitGetAsEntry: () => entry(name, node) })) }, []);
  })()`);
  const tree = { refs: { 'logo.png': 'dropped logo', deep: { 'note.md': '# Note' }, empty: {} } };
  await dropFolder(tree);
  await waitFor(`document.querySelectorAll('.library-upload.saved').length === 2 && !!document.querySelector('.library-folder[aria-label="Open folder refs"]')`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.library-upload-name')].map(node => node.textContent)`), ['refs/logo.png', 'refs/deep/note.md']);
  await click('.library-folder[aria-label="Open folder refs"]');
  await waitFor(`document.querySelectorAll('.library-asset').length === 3`);
  assert.deepEqual(await libraryNames(), ['deep', 'empty', 'logo.png'], 'the empty directory is a folder too');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.library-crumb')].map(node => node.textContent)`), ['Library', 'Thumbnails', 'refs']);
  // Dropping the same folder again into Thumbnails merges into refs, asking per file.
  await click('[data-action="library-clear-uploads"]');
  await click('.library-crumb:nth-of-type(2)');
  await waitFor(`!!document.querySelector('.library-folder[aria-label="Open folder refs"]')`);
  await dropFolder(tree);
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'A file named logo.png already exists'`);
  assert.equal(await evaluate(`document.querySelector('input[name="collision"]:checked').value`), 'create');
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'A file named note.md already exists' && document.querySelector('#form-dialog').open`);
  await click('input[name="collision"][value="cancel"]');
  await click('#small-form [type="submit"]');
  await waitFor(`[...document.querySelectorAll('.library-upload-state')].map(node => node.textContent).join() === 'Saved as logo (1).png,Cancelled'`);
  assert.equal(await evaluate(`document.querySelectorAll('.library-folder').length`), 1, 'no duplicate refs folder');
  await click('.library-folder[aria-label="Open folder refs"]');
  await waitFor(`document.querySelectorAll('.library-asset').length === 4`);

  await fill('#library-search', 'note');
  await waitFor(`document.querySelectorAll('.library-asset').length === 1`);
  assert.match(await evaluate(`document.querySelector('.library-asset .library-meta').textContent`), /^Thumbnails\/refs\/deep\/ · v1/);
  await fill('#library-search', '');
  await waitFor(`document.querySelectorAll('.library-asset').length === 4`);

  await click('.library-manage[aria-label="Manage logo (1).png"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'Organize logo (1).png'`);
  await fill('#name-input', 'mark.png');
  await evaluate(`document.querySelector('#library-destination').value = ''`);
  await click('#small-form [type="submit"]');
  await waitFor(`!document.querySelector('#form-dialog').open && document.querySelectorAll('.library-asset').length === 3`);
  await click('.library-crumb[data-id=""]');
  await waitFor(`!!document.querySelector('.library-asset[aria-label="Inspect mark.png"]')`);
  await click('.library-manage[aria-label="Manage mark.png"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'Organize mark.png'`);
  await fill('#name-input', 'logo.png');
  await click('#small-form [type="submit"]');
  await waitFor(`document.querySelector('#toast').textContent.includes('already contains logo.png')`);
  assert.ok(await evaluate(`document.querySelector('#form-dialog').open`), 'a taken name keeps the form open');
  await click('#small-form [data-action="library-remove"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'Remove mark.png?'`);
  await click('[data-action="close-form"]');

  await click('.library-manage[aria-label="Manage Thumbnails"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'Organize Thumbnails'`);
  await click('#small-form [data-action="library-remove"]');
  await waitFor(`document.querySelector('#form-heading')?.textContent === 'Remove Thumbnails?'`);
  await click('#small-form [type="submit"]');
  await waitFor(`!document.querySelector('.library-folder[aria-label="Open folder Thumbnails"]')`);
  await click('[data-action="library-removed"]');
  await waitFor(`document.querySelector('#library-heading')?.textContent === 'Removed files'`);
  // intro-notes.md is the promoted output removed after the Save to project library check.
  assert.deepEqual((await evaluate(`[...document.querySelectorAll('#library-dialog .library-version strong')].map(node => node.textContent)`)).sort(), ['Thumbnails/refs/deep/note.md', 'Thumbnails/refs/logo.png', 'intro-notes.md']);
  await click('#library-dialog [data-action="library-inspect"]');
  await waitFor(`document.querySelector('.library-location .library-badge')?.textContent === 'Removed' && !document.querySelector('#library-replace')`);
  await click('[data-action="library-close"]');
  await snapshot('library-folders');
  await click('[data-action="show-board"]');
  await waitFor(`!!document.querySelector('#board .lane')`);
  console.log('PASS Library tab uploads files and folders, resolves collisions explicitly, organizes and removes without losing history, and downloads exact versions');

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
  const fetchedCard = (await state()).projects[0].lanes.flatMap((lane) => lane.cards).find((card) => card.fields.originalVideoUrl === 'https://youtu.be/62NJbICVWkQ');
  assert.equal(fetchedCard.title, 'A borrowed idea');
  assert.equal(fetchedCard.fields.originalVideoTitle, 'A borrowed idea');
  assert.equal(await evaluate(`document.querySelector('#card-original-video-title').value`), 'A borrowed idea');
  assert.equal(fetchedCard.images.length, 1);
  assert.equal(fetchedCard.imageRoles.original, fetchedCard.images[0].id);
  assert.equal(fetchedCard.imageRoles.cover, fetchedCard.images[0].id);
  await click('[data-action="fetch-youtube"]');
  await waitFor(`document.querySelector('#upload-status') && document.querySelector('[data-action="fetch-youtube"]') && !document.querySelector('[data-action="fetch-youtube"]').disabled`);
  await saved();
  assert.equal((await state()).projects[0].lanes.flatMap((lane) => lane.cards).find((card) => card.id === fetchedCard.id).images.length, 1);
  await click('[data-action="close-card"]');
  console.log('PASS original URL fetches title and thumbnail');

  // Editor labels and limits come from the same template as server validation.
  await evaluate(`(async () => {
    const { templates } = await import('/card-template.js');
    const field = templates['youtube-video'].fields.find(field => field.key === 'titleOptions');
    window.originalTemplateField = { ...field };
    field.label = 'Candidate titles'; field.max = 1234;
  })()`);
  await click('[data-action="open-card"]');
  assert.equal(await evaluate(`document.querySelector('label[for="card-title-options"]').textContent`), 'Candidate titles');
  assert.equal(await evaluate(`document.querySelector('#card-title-options').maxLength`), 1234);
  await evaluate(`(async () => {
    const { templates } = await import('/card-template.js');
    Object.assign(templates['youtube-video'].fields.find(field => field.key === 'titleOptions'), window.originalTemplateField);
  })()`);
  await click('[data-action="close-card"]');
  console.log('PASS editor reads template labels and limits');

  // Preserve unsaved text and show actionable feedback if another tab saved the same card first.
  const conflictId = await evaluate(`document.querySelector('[data-action="open-card"]').dataset.id`);
  const { card: external } = await (await fetch(`${base}/api/cards/${conflictId}`)).json();
  assert.equal((await fetch(`${base}/api/cards/${conflictId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: external.revision, title: 'Edited in another tab' }) })).status, 200);
  await click('[data-action="open-card"]');
  const nextLane = await evaluate(`Array.from(document.querySelector('#card-lane').options).find(option => option.value !== document.querySelector('#card-lane').value).value`);
  await select('#card-lane', nextLane);
  await saved();
  const beforeIntro = (await (await fetch(`${base}/api/cards/${conflictId}`)).json()).card;
  await fill('#card-intro', 'This text must not disappear after a conflict.');
  await fetch(`${base}/api/cards/${conflictId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: beforeIntro.revision, fields: { intro: 'Other tab intro' } }) });
  await waitFor(`document.querySelector('#editor-save-error')?.textContent.includes('Unsaved conflicts') && !document.querySelector('#editor-save-error').hidden`);
  assert.equal(await evaluate(`document.querySelector('#card-intro').value`), 'This text must not disappear after a conflict.');
  assert.equal((await (await fetch(`${base}/api/cards/${conflictId}`)).json()).card.title, 'Edited in another tab');
  console.log('PASS moving a stale card preserves conflict protection and unsaved edits');

  await click('[data-action="close-card"]');
  await waitFor(`!document.querySelector('#card-dialog').open`);
  await click('.header-actions [data-action="add-card"]');
  await fill('#card-title', 'Saved despite another card’s conflict');
  const independentId = await evaluate(`(async () => (await import('/state.js')).state.cardId)()`);
  await waitFor(`(async () => (await fetch('/api/cards/' + ${JSON.stringify(independentId)}).then(r => r.json())).card?.title === 'Saved despite another card’s conflict')()`);
  await click('[data-action="close-card"]');
  await waitFor(`!document.querySelector('#card-dialog').open`);
  await click(`[data-action="open-card"][data-id="${conflictId}"]`);
  assert.equal(await evaluate(`document.querySelector('#card-intro').value`), 'This text must not disappear after a conflict.');
  await click('[data-action="use-saved-card"]');
  await waitFor(`document.querySelector('#form-dialog').open`);
  await click('#form-dialog [data-action="close-form"]');
  assert.equal(await evaluate(`document.querySelector('#card-intro').value`), 'This text must not disappear after a conflict.');
  await click('[data-action="use-saved-card"]');
  await click('#small-form button[type="submit"]');
  await waitFor(`!document.querySelector('#form-dialog').open && document.querySelector('#card-title').value === 'Edited in another tab'`);
  await saved();
  await fill('#card-intro', 'Resolved and saved');
  await saved();
  assert.equal((await (await fetch(`${base}/api/cards/${conflictId}`)).json()).card.fields.intro, 'Resolved and saved');
  console.log('PASS unrelated cards save during conflict, and confirmed resolution resumes saving');

  // Cumulative cases 1 and 12 use controlled native events through the real
  // HTTP/worker/browser path. Native availability has its separate live gate.
  await click('[data-action="close-card"]');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  async function api(method, url, body) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  }
  const chatWorkspace = await api('GET', '/api/workspace'); const chatProject = chatWorkspace.projects[0];
  const chatStage = chatWorkspace.flows.find((flow) => flow.id === chatProject.flowId).stages[0].id;
  const a = await api('POST', `/api/projects/${chatProject.id}/cards`, { stageId: chatStage, title: 'Chat browser A', images: fetchedCard.images, imageRoles: fetchedCard.imageRoles });
  const b = await api('POST', `/api/projects/${chatProject.id}/cards`, { stageId: chatStage, title: 'Chat browser B' });
  await send('Page.navigate', { url: base });
  const open = async (id) => {
    await waitFor(`!!document.querySelector('[data-action="open-card"][data-id="${id}"]')`);
    await click(`[data-action="open-card"][data-id="${id}"]`);
    await waitFor(`!!document.querySelector('#chat-prompt')`);
  };
  const chat = (id) => api('GET', `/api/cards/${id}/chat`);
  await open(a.id);
  await fill('#chat-prompt', 'Draft A persists');
  await click('[data-action="toggle-chat"]');
  await click('[data-action="toggle-chat"]');
  assert.equal(await evaluate(`document.querySelector('#chat-prompt').value`), 'Draft A persists');
  await open(b.id); await fill('#chat-prompt', 'Draft B persists');
  await open(a.id); assert.equal(await evaluate(`document.querySelector('#chat-prompt').value`), 'Draft A persists');
  assert.equal(codex.threads.size, 0, 'Idle views never create native conversations.');
  assert.equal(await evaluate(`!!document.querySelector('[data-action="chat-discover"]')`), false, 'Models are shared globally without per-chat discovery.');
  await waitFor(`!!document.querySelector('#chat-model option[value="test-model"]')`);
  await select('#chat-model', 'test-model');
  await click('[data-action="chat-send"]');
  for (let i = 0; i < 100 && !codex.sends.length; i++) await pause(20);
  assert.equal(codex.sends.length, 1);
  const first = codex.sends[0];
  codex.emit(first.threadId, { type: 'delta', turnId: first.turnId, itemId: 'browser-partial', delta: 'Streamed browser evidence' });
  await waitFor(`document.querySelector('#chat-transcript').textContent.includes('Streamed browser evidence')`);
  await open(b.id);
  assert.equal(await evaluate(`document.querySelector('#chat-prompt').value`), 'Draft B persists');
  await waitFor(`!!document.querySelector('[data-activity-card="${a.id}"].working')`);
  const firstTimer = await evaluate(`document.querySelector('[data-activity-card="${a.id}"]').textContent`);
  await waitFor(`document.querySelector('[data-activity-card="${a.id}"]').textContent !== ${JSON.stringify(firstTimer)}`);
  assert.equal((await chat(a.id)).attempts[0].status, 'running', 'Switching does not stop work.');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(`document.querySelector('[data-activity-card="${a.id}"].working').getAnimations().length`), 0);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await click('[data-action="workbench-tab"][data-tab="chat"]');
  assert.equal(await evaluate(`document.querySelector('#chat-prompt').value`), 'Draft B persists');
  await snapshot('phase-1-mobile-chat');
  await click('[data-action="close-card"]'); await open(b.id);
  assert.equal(await evaluate(`document.querySelector('#chat-prompt').value`), 'Draft B persists');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await open(a.id);
  await waitFor(`document.querySelector('#chat-transcript').textContent.includes('Streamed browser evidence')`);
  const frozen = (await chat(a.id)).submissions[0];
  assert.equal(frozen.context.images[0].id, fetchedCard.images[0].id, 'Exact role reference remains frozen.');
  console.log('PASS idle chats, desktop/mobile drafts and references, switch/hide/reopen, independent work and static reduced-motion indication');

  await click('[data-action="close-card"]');
  codex.request(first);
  await waitFor(`!!document.querySelector('[data-activity-card="${a.id}"].input-needed')`);
  await click('[data-action="workspace-chat-activity"]');
  await click(`[data-action="chat-activity-card"][data-id="${a.id}"]`);
  await waitFor(`document.activeElement?.dataset.action === 'chat-answer'`);
  assert.equal(await evaluate(`document.activeElement.dataset.id`), (await chat(a.id)).requests.find((entry) => entry.status === 'pending').id);
  await snapshot('phase-1-input-needed');
  await click('[data-action="chat-answer"][data-decision="accept"]');
  await click('[data-action="close-card"]'); codex.finish(first);
  await waitFor(`!!document.querySelector('[data-activity-card="${a.id}"].done')`);
  await api('POST', `/api/cards/${a.id}/chat/viewed`, {});
  await waitFor(`!document.querySelector('[data-activity-card="${a.id}"].done')`);
  await open(a.id);
  await fill('#chat-prompt', 'Second response for hidden-view Done'); await click('[data-action="chat-send"]');
  for (let i = 0; i < 100 && codex.sends.length < 2; i++) await pause(20);
  assert.equal(codex.sends.length, 2);
  await click('[data-action="toggle-chat"]'); codex.finish(codex.sends[1]);
  await waitFor(`!!document.querySelector('[data-activity-card="${a.id}"].done')`);
  await click('[data-action="toggle-chat"]');
  await waitFor(`!document.querySelector('[data-activity-card="${a.id}"].done')`);
  console.log('PASS Working timer, streamed text, Input needed navigation/focus, other-tab Done clearing and hidden-chat reveal');
  // A Library script selected in the composer is previewed, sent in full and shown frozen in history.
  const libraryCard = await api('POST', `/api/projects/${chatProject.id}/cards`, { stageId: chatStage, title: 'Chat Library card' });
  await api('POST', `/api/projects/${chatProject.id}/library/folders`, { name: 'Next episode' });
  await send('Page.navigate', { url: base }); await open(libraryCard.id);
  await evaluate(`document.querySelector('#chat-context-preview').open = true`);
  await click('[data-action="chat-library-add"]');
  await waitFor(`[...document.querySelectorAll('#small-form label')].some(label => label.textContent.includes('script.md'))`);
  for (const name of ['script.md', 'opaque.bin']) await evaluate(`[...document.querySelectorAll('#small-form label')].find(label => label.textContent.includes(${JSON.stringify(name)})).querySelector('input').click()`);
  // An existing empty folder is a valid selection that adds no files.
  await evaluate(`[...document.querySelectorAll('#small-form label')].find(label => label.textContent.startsWith('Next episode/')).querySelector('input').click()`);
  await click('#small-form button[type="submit"]');
  await waitFor(`document.querySelector('.chat-library ol')?.textContent.includes('script.md') && document.querySelector('.chat-library ol')?.textContent.includes('opaque.bin') && document.querySelector('.chat-library ol')?.textContent.includes('Next episode/')`);
  await waitFor(`document.querySelector('#chat-exact-preview .chat-library-inputs')?.textContent.includes('full text inline')`);
  await waitFor(`document.querySelector('#chat-exact-preview .chat-library-inputs')?.textContent.includes('workspace copy for Codex tools')`);
  assert.ok(await evaluate(`document.querySelector('#chat-exact-preview').textContent.includes('only with its shell tool')`), 'The preview says how a copy can be read and claims no comprehension.');
  assert.ok(await evaluate(`document.querySelector('#chat-exact-preview').textContent.includes('Next episode/ · no files')`), 'The preview lists the selection in order, showing that the empty folder adds no files.');
  await snapshot('chat-library-selection');
  await select('#chat-model', 'test-model'); await fill('#chat-prompt', 'Tighten the hook using the script');
  await click('[data-action="chat-send"]');
  for (let i = 0; i < 100 && codex.sends.length < 3; i++) await pause(20);
  assert.equal(codex.sends.length, 3, await evaluate(`document.querySelector('#chat-error').textContent + ' / ' + document.querySelector('#chat-transcript').textContent`));
  assert.ok(codex.sends[2].input[0].text.includes('Hook: the desk studio.'), 'The selected script is sent in full.');
  codex.finish(codex.sends[2]);
  await waitFor(`document.querySelector('.chat-delivery')?.textContent.includes('script.md · full text inline · sent')`);
  assert.ok(await evaluate(`document.querySelector('.chat-delivery').textContent.includes('opaque.bin · workspace copy for Codex tools · sent')`), 'History names the copy route per attempt.');
  assert.ok(await evaluate(`document.querySelector('.chat-library ol')?.textContent.includes('script.md')`), 'An ordinary message keeps the selection.');
  assert.ok(await evaluate(`document.querySelector('#chat-transcript').textContent.includes('Next episode/ · no files')`), 'Submitted context keeps the frozen selection, including the empty folder.');
  // Drag a folder from the picker onto the composer: it overlaps the selected script, which is previewed once with both selection paths.
  const thumbnailsFolder = await api('POST', `/api/projects/${chatProject.id}/library/folders`, { name: 'Thumbnails' });
  const libraryListing = await api('GET', `/api/projects/${chatProject.id}/library`);
  await api('PATCH', `/api/projects/${chatProject.id}/library/assets/${libraryListing.assets.find((entry) => entry.filename === 'script.md' && !entry.folderId).id}`, { folderId: thumbnailsFolder.id });
  await click('[data-action="chat-library-add"]');
  await waitFor(`!!document.querySelector('#small-form [data-library-source="folder:${thumbnailsFolder.id}"]')`);
  // A drag that ends before the picker lifts leaves the picker as it was.
  await evaluate(`(() => { const entry = document.querySelector('#small-form [data-library-source]'); const dataTransfer = new DataTransfer();
    for (const type of ['dragstart', 'dragend']) entry.dispatchEvent(new DragEvent(type, { bubbles: true, dataTransfer })); })()`);
  await pause(60);
  assert.ok(await evaluate(`document.querySelector('#form-dialog').matches(':modal:not(.lifted)')`), 'A cancelled drag never strands the picker lifted.');
  const dragPoints = await evaluate(`(() => {
    const a = document.querySelector('#small-form [data-library-source="folder:${thumbnailsFolder.id}"]').getBoundingClientRect();
    const zone = document.querySelector('.chat-library'); zone.scrollIntoView({ block: 'center' });
    const b = zone.getBoundingClientRect();
    return { x1: a.left + 20, y1: a.top + a.height / 2, x2: b.left + b.width / 2, y2: b.top + b.height / 2 };
  })()`);
  interceptedDrag = null;
  await send('Input.setInterceptDrags', { enabled: true });
  try {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragPoints.x1, y: dragPoints.y1 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragPoints.x1, y: dragPoints.y1, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 5; step++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragPoints.x1 + (dragPoints.x2 - dragPoints.x1) * step / 5, y: dragPoints.y1 + (dragPoints.y2 - dragPoints.y1) * step / 5, button: 'left', buttons: 1 });
    for (let attempt = 0; attempt < 30 && !interceptedDrag; attempt++) await pause(20);
    assert.ok(interceptedDrag, 'Dragging a picker folder starts a native drag');
    // The picker lifts away so the composer underneath takes the drop.
    await waitFor(`document.querySelector('#form-dialog').matches('.lifted') && !document.querySelector('dialog:modal')`);
    for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: dragPoints.x2, y: dragPoints.y2, data: interceptedDrag });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragPoints.x2, y: dragPoints.y2, button: 'left', clickCount: 1 });
  } finally { await send('Input.setInterceptDrags', { enabled: false }); }
  await waitFor(`!document.querySelector('#form-dialog').open && document.querySelector('.chat-library ol li:last-child')?.textContent.includes('Thumbnails/')`);
  await waitFor(`[...document.querySelectorAll('#chat-exact-preview .chat-library-inputs li')].some(node => node.textContent.includes('Thumbnails/script.md') && node.textContent.includes('selected directly · in selected folder Thumbnails/ as script.md'))`);
  assert.equal(await evaluate(`[...document.querySelectorAll('#chat-exact-preview .chat-library-inputs li')].filter(node => node.textContent.includes('script.md')).length`), 1, 'An overlapping file is previewed once.');
  await snapshot('chat-library-folder-drop');
  await click('[data-action="close-card"]');
  console.log('PASS Library script and opaque file selected in the composer, previewed by route, sent and shown frozen with their delivery; a folder dragged from the picker overlaps it once with both selection paths');
  // Global settings and provider combinations use one saved catalog for all cards.
  await click('[data-action="close-card"]');
  await waitFor(`import('/chat.js').then(m => !m.hasUnsentChatChanges())`);
  await waitFor(`import('/state.js').then(m => !m.hasUnsavedWork())`);
  assert.equal(await evaluate(`document.querySelector('a[aria-label="General settings"]').textContent`), 'Settings');
  await send('Page.navigate', { url: base + '/settings.html' });
  await waitFor(`!!document.querySelector('input[data-provider="claude"]')`);
  await click('input[data-provider="claude"]');
  await waitFor(`document.querySelector('#models').textContent.includes('sonnet')`);
  assert.equal((await api('GET', '/api/settings')).providers.filter((p) => p.enabled).length, 2);
  await fill('#claude-instructions', 'Shared Claude guidance');
  await click('#claude-guidance button');
  await waitFor(`document.querySelector('#status').textContent.includes('instructions saved')`);
  await click('input[data-provider="codex"]');
  await waitFor(`!document.querySelector('input[data-provider="codex"]').disabled`);
  await send('Page.navigate', { url: base + '/settings.html' });
  await waitFor(`!!document.querySelector('input[data-provider="claude"]')`);
  assert.equal(await evaluate(`document.querySelector('input[data-provider="codex"]').checked`), false);
  assert.equal(await evaluate(`document.querySelector('input[data-provider="claude"]').checked`), true);
  assert.equal(await evaluate(`document.querySelector('#claude-instructions').value`), 'Shared Claude guidance');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth`), false);
  await snapshot('global-settings-mobile');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base }); await open(b.id);
  await waitFor(`!!document.querySelector('#chat-provider option[value="claude"]')`);
  await select('#chat-provider', 'claude');
  await waitFor(`!!document.querySelector('#chat-model option[value="sonnet"]')`);
  await select('#chat-model', 'sonnet'); await fill('#chat-prompt', 'Claude from shared models');
  await click('[data-action="chat-send"]');
  await waitFor(`document.querySelector('#chat-provider').disabled`);
  await waitFor(`document.querySelector('#chat-transcript').textContent.includes('In progress')`);
  assert.equal(claude.sends.length, 1); claude.finish(claude.sends[0], 'completed', 'Claude browser reply');
  await waitFor(`document.querySelector('#chat-transcript').textContent.includes('Claude browser reply')`);
  // Hold a model response that captured the enabled provider, then change
  // settings while that response is pending. The next refresh must not vanish.
  await evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.catalogGate = { captured: false, release: null, original };
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (args[0] === '/api/models' && !window.catalogGate.captured) {
        window.catalogGate.captured = true;
        await new Promise(resolve => { window.catalogGate.release = resolve; });
      }
      return response;
    };
    window.dispatchEvent(new Event('focus'));
  })()`);
  await waitFor(`window.catalogGate.captured`);
  const claudeSettings = await api('GET', '/api/providers/claude');
  await api('PUT', '/api/providers/claude', { revision: claudeSettings.revision, selection: { ...claudeSettings.selection, enabled: false } });
  await evaluate(`window.dispatchEvent(new Event('focus')); window.catalogGate.release()`);
  await waitFor(`document.querySelector('#chat-composer').textContent.includes('Enable Claude or Codex')`);
  assert.equal(await evaluate(`document.querySelector('[data-action="chat-send"]').disabled`), true);
  await evaluate(`window.fetch = window.catalogGate.original; delete window.catalogGate`);
  const disabledClaude = await api('GET', '/api/providers/claude');
  await api('PUT', '/api/providers/claude', { revision: disabledClaude.revision, selection: { ...disabledClaude.selection, enabled: true } });
  await waitFor(`!!document.querySelector('#chat-model option[value="sonnet"]:not([disabled])')`);
  await click('[data-action="close-card"]');
  await waitFor(`import('/chat.js').then(m => !m.hasUnsentChatChanges())`);
  await waitFor(`import('/state.js').then(m => !m.hasUnsavedWork())`);
  await send('Page.navigate', { url: base + '/settings.html' });
  await waitFor(`!!document.querySelector('input[data-provider="claude"]')`);
  await click('input[data-provider="claude"]');
  await waitFor(`document.querySelector('#models').textContent.includes('Both providers are disabled')`);
  assert.equal(await evaluate(`document.querySelector('#refresh-models').disabled`), true);
  await send('Page.navigate', { url: base }); await open(b.id);
  await waitFor(`document.querySelector('#chat-composer').textContent.includes('Enable Claude or Codex')`);
  assert.equal(await evaluate(`document.querySelector('[data-action="chat-send"]').disabled`), true);
  console.log('PASS global Settings, independent provider toggles, saved models/instructions, Claude chat, disabled sends and mobile layout');
  // A manual export from Settings pauses changes, then reports the verified folder.
  await click('[data-action="close-card"]');
  await waitFor(`import('/state.js').then(m => !m.hasUnsavedWork())`);
  await send('Page.navigate', { url: base + '/settings.html' });
  await waitFor(`document.querySelector('#backup-output').value.endsWith('backups')`);
  await fill('#backup-output', path.join(temporary, 'browser-backups'));
  await click('#backup-start');
  await waitFor(`document.querySelector('#backup-status').textContent.includes('Backup saved to')`);
  assert.equal(await evaluate(`document.querySelector('#backup-cancel').hidden`), true);
  assert.equal((await api('GET', '/api/maintenance')).last.status, 'completed');
  await snapshot('settings-export');
  console.log('PASS Settings export pauses changes and reports the verified backup folder');
  assert.deepEqual(browserErrors, []);
  console.log('All browser checks passed. Screenshots: test-results/');
} finally {
  socket?.close();
  chrome.kill();
  await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
