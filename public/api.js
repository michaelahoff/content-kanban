// Talks to the server. Writes run one at a time, in the order they were made,
// so a card is always created before it is edited or moved. A failed write
// stays at the front of the queue until it is retried. Card conflicts are
// handed back to the card's owner so unrelated writes can continue.
const queue = [];
let running = false;
let error = '';
const listeners = new Set();

export async function request(url, options = {}) {
  const response = await fetch(url, options);
  let result = {};
  try { result = await response.json(); } catch { /* Handled by the status check below. */ }
  if (!response.ok) throw Object.assign(new Error(result.error || 'Something went wrong. Please try again.'), { status: response.status });
  return result;
}

export const send = (method, url, body) => request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function notify() { listeners.forEach((listener) => listener()); }
export function onSyncChange(listener) { listeners.add(listener); }
export function syncState() { return { pending: queue.length, error }; }

async function drain() {
  if (running) return;
  running = true;
  while (queue.length && !error) {
    const operation = queue[0];
    try {
      const result = await operation.run();
      queue.shift();
      operation.resolve(result);
    } catch (failure) {
      if (operation.rejectOnError) {
        queue.shift();
        operation.reject(failure);
      } else if (failure.status === 409 && operation.onConflict) {
        queue.shift();
        operation.onConflict(failure);
        operation.resolve(null);
      } else error = failure.message;
    }
  }
  running = false;
  notify();
}

// Queues a write and resolves with its result once it has been saved.
export function enqueue(run, onConflict, { rejectOnError = false } = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ run, resolve, reject, onConflict, rejectOnError });
    notify();
    drain();
  });
}

export function retry() {
  error = '';
  notify();
  drain();
}
