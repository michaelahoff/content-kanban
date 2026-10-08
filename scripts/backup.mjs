import path from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createBackup, restoreBackup } from '../backup.js';
import { lockDataDirectory } from '../data-lock.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'data-dir': { type: 'string', default: process.env.DATA_DIR || 'data' },
    output: { type: 'string', default: 'backups' }, backup: { type: 'string' },
    'codex-home': { type: 'string', default: process.env.CODEX_HOME || path.join(homedir(), '.codex') },
  } });
  if (positionals.length !== 1 || !['create', 'restore'].includes(positionals[0]) || (positionals[0] === 'restore' && !values.backup)) {
    throw new Error('Usage: node scripts/backup.mjs create [--data-dir data] [--output backups] [--codex-home home]\n       node scripts/backup.mjs restore --backup folder [--data-dir data] [--codex-home home]');
  }
  const options = { dataDir: values['data-dir'], output: values.output, backupDir: values.backup, codexHome: values['codex-home'] };
  const lock = await lockDataDirectory(options.dataDir);
  try {
    options.dataDir = lock.dataDir;
    const result = await (positionals[0] === 'create' ? createBackup(options) : restoreBackup(options));
    console.log(JSON.stringify(result, null, 2));
  } finally { lock.release(); }
} catch (error) { console.error(error.message); process.exitCode = 1; }
