// Deliberately exits without cleanup in the middle of a restore.
import { restoreBackup } from '../../backup.js';
const [backupDir, dataDir, codexHome, phase] = process.argv.slice(2);
await restoreBackup({ backupDir, dataDir, codexHome, checkpoint: async (boundary) => { if (boundary === phase) process.exit(86); } });
throw new Error('Expected crash checkpoint did not run.');
