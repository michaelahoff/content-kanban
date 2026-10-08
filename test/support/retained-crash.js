// Deliberately exits without cleanup to exercise real SQLite/FS crash recovery.
import { openStore } from '../../store.js';
const [dataDir, phase] = process.argv.slice(2);
let armed = false;
const store = await openStore({ dataDir, retainedCheckpoint: async (boundary) => {
  if (armed && boundary === phase) process.exit(86);
} });
const ctx = { ...store.owner, actor: 'system:crash-test' };
const projectId = store.workspace(ctx).projects[0].id;
const descriptor = { operationId: 'seed', projectId, kind: 'asset', filename: 'opaque.bin' };
const seed = await store.retained.publish(ctx, descriptor, Buffer.from('abc'));
armed = true;
await store.retained.publish(ctx, { ...descriptor, operationId: 'replacement', objectId: seed.objectId }, Buffer.from('new'));
throw new Error('Expected crash checkpoint did not run.');
