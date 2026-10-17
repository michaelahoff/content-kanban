// The publish lane action (ADR 0011): copies a card's saved outputs to a site
// and serves local sites under /sites/<site>/<slug>/. Remote targets
// (user@host:/path) are rsync commands Frameboard runs outside the agent
// sandbox; this first version stages locally and records the command.
//
// STUB: the real implementation replaces this file. The contract is fixed:
//   const publisher = createPublisher({ dataDir });
//   publisher.root                      → <dataDir>/sites
//   await publisher.file(relativePath)  → { path, size, type, kind } for a published file, or null
//   await publisher.publish({ store, ctx, card, settings, run }) → { status: 'published' | 'simulated' | 'failed', url, files, command, message }
import path from 'node:path';

export function createPublisher({ dataDir }) {
  const root = path.join(dataDir, 'sites');
  return {
    root,
    async file(relative) { void relative; return null; },
    async publish() { throw Object.assign(new Error('Publishing is not available yet.'), { status: 501 }); },
  };
}
