// Deliberately exits without cleanup in the middle of an export.
import { createBackup } from '../../backup.js';
const [dataDir, output, codexHome, phase] = process.argv.slice(2);
await createBackup({ dataDir, output, codexHome, checkpoint: async (boundary) => { if (boundary === phase) process.exit(86); } });
throw new Error('Expected crash checkpoint did not run.');
