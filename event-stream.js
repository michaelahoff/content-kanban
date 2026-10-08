// Server-Sent Events for the browser; commands stay HTTP requests. Durable
// activity entries carry their log ID as the event ID, so a reconnect with
// Last-Event-ID replays exactly what was missed. A client too far behind, or
// holding a cursor this database never issued, is told to reload snapshots.
// Streaming deltas are not durable; they carry their item's character offset.
export function createEventStream({ store, replayLimit = 500, heartbeatMs = 15000 }) {
  const clients = new Set();
  let scheduled = false;
  const frame = (id, event, data) => `${id === null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  function resync(client) {
    client.cursor = store.workspace(client.ctx).eventCursor;
    client.res.write(frame(client.cursor, 'resync', { cursor: client.cursor }));
  }
  function catchUp(client) {
    const entries = store.events(client.ctx, { since: client.cursor, limit: replayLimit + 1 });
    if (entries.length > replayLimit) return resync(client);
    for (const entry of entries) {
      client.cursor = entry.id;
      client.res.write(frame(entry.id, 'activity', entry));
    }
  }
  return {
    open(ctx, req, res, since) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      const latest = store.workspace(ctx).eventCursor;
      const client = { ctx, res, cursor: since ?? latest };
      clients.add(client);
      if (client.cursor > latest) resync(client); else catchUp(client);
      client.heartbeat = setInterval(() => res.write(': keepalive\n\n'), heartbeatMs);
      client.heartbeat.unref();
      req.on('close', () => { clearInterval(client.heartbeat); clients.delete(client); });
    },
    // Called after every commit; one catch-up per client covers a burst.
    notify() {
      if (scheduled || !clients.size) return;
      scheduled = true;
      setImmediate(() => {
        scheduled = false;
        for (const client of clients) {
          try { catchUp(client); } catch (error) { console.error(error); }
        }
      });
    },
    delta(workspaceId, data) {
      for (const client of clients) if (client.ctx.workspaceId === workspaceId) client.res.write(frame(null, 'delta', data));
    },
    close() {
      for (const client of clients) { clearInterval(client.heartbeat); client.res.end(); }
      clients.clear();
    },
  };
}
