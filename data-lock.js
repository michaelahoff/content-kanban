import { DatabaseSync } from 'node:sqlite';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

// SQLite owns the OS lock and releases it on process death. A separate database
// holds it for the entire app/backup/restore operation, outside app transactions.
export async function lockDataDirectory(dataDir) {
  dataDir = path.resolve(dataDir);
  await mkdir(path.dirname(dataDir), { recursive: true });
  dataDir = await realpath(dataDir).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }) ?? path.join(await realpath(path.dirname(dataDir)), path.basename(dataDir));
  const filename = path.join(path.dirname(dataDir), `.${path.basename(dataDir)}.frameboard-lock.sqlite`);
  const db = holdExclusiveLock(filename);
  if (!db) throw new Error('Stop Frameboard before backup or restore. Another app or backup/restore operation is using this data directory.');
  return { dataDir, release: () => db.close() };
}

// Returns an open database holding the file's OS lock, or null if another
// connection holds it. The kernel releases the lock when the process dies.
export function holdExclusiveLock(filename) {
  let db;
  try {
    db = new DatabaseSync(filename);
    db.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
    return db;
  } catch (error) {
    db?.close();
    if (error.errcode === 5 || /locked/.test(error.message)) return null;
    throw error;
  }
}
