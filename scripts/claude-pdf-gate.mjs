// The live Claude PDF gate (#66). Runs the installed Claude Code through
// Frameboard's own adapter, tools disabled and outside retained-data
// protection (Claude has no protected configuration yet), on the signed-in
// account. For each model it checks two things:
//
// - comprehension: a two-page PDF whose codes exist only as rendered page
//   text is sent as a native document, and the reply must give both codes;
// - native rejection: a PDF the API cannot process must fail the turn, never
//   complete without it.
//
// It prints one evidence record per passing model. With --record it writes
// them to claude-pdf-evidence.json, replacing records for the same setup.
// Each check is a small request on the signed-in subscription.
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeAdapter } from '../claude-adapter.js';
import { sameSetup } from '../claude-pdf-gate.js';

const evidenceFile = fileURLToPath(new URL('../claude-pdf-evidence.json', import.meta.url));
// Documented pages per request: 100 for 200K-context models, 600 otherwise
// (Claude API reference, cached 2026-09-25). Models not listed are not recorded.
const documentedPages = { 'claude-haiku-4-5': 100, 'claude-haiku-4-5-20251001': 100,
  ...Object.fromEntries(['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'].map((model) => [model, 600])) };
const timeoutMs = 180000;

// A minimal valid PDF of Helvetica text pages, with the binary marker line
// real PDFs carry.
function textPdf(pages) {
  const objects = []; const add = (body) => objects.push(body);
  add(null); add(null); add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = pages.map((lines) => {
    const ops = lines.map((line, index) => `BT /F1 18 Tf 72 ${720 - index * 28} Td (${line}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'; const offsets = [];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function turn(adapter, work, model, text, pdfPath) {
  const opened = await adapter.openThread({ cwd: work, model, threadConfig: { developerInstructions: '' } });
  const events = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No result within ${timeoutMs / 1000} s.`)), timeoutMs);
    adapter.subscribe(opened.threadId, { onEvent: (event) => { events.push(event); if (event.type === 'turn-completed') { clearTimeout(timer); resolve(event); } } });
  });
  await adapter.startTurn({ threadId: opened.threadId, model, clientUserMessageId: randomUUID(), input: [{ type: 'text', text }, { type: 'localDocument', path: pdfPath }] });
  const completed = await done;
  return { completed, rejected: events.some((event) => event.type === 'input-rejected'),
    reply: events.filter((event) => event.type === 'item-completed').map((event) => event.item.text).join('\n') };
}

const work = await mkdtemp(path.join(tmpdir(), 'frameboard-claude-pdf-gate-'));
const adapter = createClaudeAdapter({ cwd: work, pdfEvidence: [] });
const records = []; let failed = false;
try {
  const discovery = await adapter.discover({ cwd: work });
  const { version, account } = discovery.harness;
  console.log(`Claude Code ${version ?? '(unknown version)'} · ${account?.subscriptionType ?? 'no subscription'} · ${account?.apiProvider ?? 'unknown provider'}`);
  if (!version || account?.apiProvider !== 'firstParty' || !account.subscriptionType) throw new Error('The gate needs a known Claude Code version signed in to a subscribed first-party account.');
  const models = [...new Map(discovery.models.map((model) => [model.resolvedModel ?? model.id, model])).values()];
  for (const model of models) {
    const resolved = model.resolvedModel ?? model.id;
    if (!documentedPages[resolved]) { console.log(`${resolved}: skipped, no documented PDF page limit.`); continue; }
    // A model this account cannot use fails its check; the others still run.
    try {
      const codes = [randomBytes(3).toString('hex').toUpperCase(), randomBytes(3).toString('hex').toUpperCase()];
      const readable = path.join(work, `${randomUUID()}.pdf`);
      await writeFile(readable, textPdf([['Frameboard PDF gate, page one', `First code: ${codes[0]}`], ['Frameboard PDF gate, page two', `Second code: ${codes[1]}`]]));
      const read = await turn(adapter, work, model.id, 'Reply with only the two codes printed in the attached PDF, first then second, separated by one space.', readable);
      const comprehension = read.completed.status === 'completed' && !read.rejected && read.reply.includes(`${codes[0]} ${codes[1]}`);
      const unreadable = path.join(work, `${randomUUID()}.pdf`);
      await writeFile(unreadable, Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\nThis is not a PDF body.\n%%EOF\n', 'latin1'));
      const broken = await turn(adapter, work, model.id, 'Reply with the code printed in the attached PDF.', unreadable);
      const rejection = broken.completed.status === 'failed' && broken.rejected;
      console.log(`${resolved}: comprehension ${comprehension ? 'passed' : `failed (${read.completed.status}: ${read.reply.slice(0, 200)})`}; rejection ${rejection ? 'passed' : `failed (${broken.completed.status})`}`);
      if (!comprehension || !rejection) { failed = true; continue; }
      records.push({ harness: version, model: resolved, account, retainedDataProtection: false, pages: documentedPages[resolved], checked: new Date().toISOString().slice(0, 10),
        result: 'Read both page codes from a two-page PDF document; an unprocessable PDF failed the turn.' });
    } catch (cause) { console.log(`${resolved}: failed (${cause.message})`); failed = true; }
  }
} finally {
  await adapter.close(); await rm(work, { recursive: true, force: true });
}
console.log(JSON.stringify(records, null, 2));
if (process.argv.includes('--record')) {
  const kept = JSON.parse(await readFile(evidenceFile, 'utf8')).filter((old) => !records.some((record) => sameSetup(old, record)));
  await writeFile(evidenceFile, JSON.stringify([...kept, ...records], null, 2) + '\n');
  console.log(`Recorded ${records.length} passing setups in claude-pdf-evidence.json.`);
}
if (failed) process.exitCode = 1;
