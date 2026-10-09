// The only bridge out of the native network namespace. The peer receives an
// already-connected pipe, never a host socket path or application credential.
import net from 'node:net';
import { lookup } from 'node:dns/promises';

function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a > 0 && a < 224 && ![10, 127, 169, 192].includes(a)
    && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 198 && [18, 19].includes(b));
}
export function attachNativeProxy(pipe, { testPorts = [] } = {}) {
  const sockets = new Map(); let buffer = '';
  const send = (message) => { if (!pipe.destroyed) pipe.write(JSON.stringify(message) + '\n'); };
  async function receive(message) {
    const { id } = message;
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid proxy stream.');
    if (message.type === 'open') {
      if (sockets.has(id) || sockets.size >= 64) throw new Error('Too many proxy streams.');
      const test = message.host === '127.0.0.1' && testPorts.includes(message.port);
      if (!test && (message.port !== 443 || !['api.openai.com', 'chatgpt.com', 'auth.openai.com'].includes(message.host))) throw new Error('Only the verified OpenAI HTTPS endpoints are available.');
      const addresses = test ? [{ address: '127.0.0.1' }] : await lookup(message.host, { family: 4, all: true });
      if (!addresses.length || !test && addresses.some(({ address }) => !publicIPv4(address))) throw new Error('Local and private network destinations are unavailable.');
      if (pipe.destroyed) return;
      const socket = net.connect({ host: addresses[0].address, port: message.port });
      sockets.set(id, socket);
      socket.setTimeout(120000, () => socket.destroy());
      socket.on('connect', () => send({ id, type: 'ready' }));
      socket.on('data', (data) => send({ id, type: 'data', data: data.toString('base64') }));
      socket.on('error', () => {});
      socket.on('close', () => { sockets.delete(id); send({ id, type: 'close' }); });
    } else if (message.type === 'data') {
      if (typeof message.data !== 'string' || message.data.length > 131072) throw new Error('Invalid proxy data.');
      sockets.get(id)?.write(Buffer.from(message.data, 'base64'));
    } else if (message.type === 'close') sockets.get(id)?.destroy();
    else throw new Error('Invalid proxy operation.');
  }
  pipe.setEncoding('utf8');
  pipe.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 262144) { pipe.destroy(); return; }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { pipe.destroy(); return; }
      if (!message || typeof message !== 'object') { pipe.destroy(); return; }
      receive(message).catch(() => send({ id: message.id, type: 'close' }));
    }
  });
  pipe.on('error', () => {});
  pipe.on('close', () => { for (const socket of sockets.values()) socket.destroy(); sockets.clear(); });
}
