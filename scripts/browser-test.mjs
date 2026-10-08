import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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
  codex.finish(laneSend, 'completed', 'Here it is.\n\n```frameboard-result\n{"fields": {"intro": "A lane-written intro"}, "notes": "Wrote the intro in the voice guide."}\n```');
  await waitFor(`document.querySelector('#card-intro').value === 'A lane-written intro'`);
  await waitFor(`document.querySelector('#lane-notes').value.includes('Wrote the intro in the voice guide.')`);
  await waitFor(`document.querySelector('.card-playbook-run')?.textContent.includes('Applied Intro')`);
  await waitFor(`document.querySelector('.chat-lane-run')?.textContent.includes('Archived playbook')`);
  await snapshot('lane-run-result');
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
  assert.deepEqual(browserErrors, []);
  console.log('All browser checks passed. Screenshots: test-results/');
} finally {
  socket?.close();
  chrome.kill();
  await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
  await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
