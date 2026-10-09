// Runs inside the confined namespace. All remote sockets belong to the trusted
// parent broker; this relay can request only the broker's validated targets.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const pipe = new net.Socket({ fd: 3, readable: true, writable: true });
const streams = new Map(); let nextId = 1; let buffer = '';
const send = (message) => pipe.write(JSON.stringify(message) + '\n');
function open(host, port, ready, data, close) {
  const id = nextId++;
  streams.set(id, { ready, data, close }); send({ id, type: 'open', host, port });
  return id;
}
const proxy = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
  // Plain HTTP is exclusively for an explicitly injected native test peer.
  // The host broker rejects all other non-HTTPS ports and private addresses.
  const id = open(url.hostname, Number(url.port || 80), () => {
    const headers = { ...req.headers, host: url.host, connection: 'close' };
    delete headers['proxy-connection']; delete headers['proxy-authorization'];
    const head = `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`;
    send({ id, type: 'data', data: Buffer.from(head).toString('base64') });
    req.on('data', (chunk) => send({ id, type: 'data', data: chunk.toString('base64') }));
    req.resume();
  }, (chunk) => res.socket?.write(chunk), () => { res.socket?.end(); });
  req.pause();
  res.on('close', () => { streams.delete(id); send({ id, type: 'close' }); });
});
proxy.on('connect', (req, socket, head) => {
  let url;
  try { url = new URL(`https://${req.url}`); } catch { socket.destroy(); return; }
  const id = open(url.hostname, Number(url.port || 443), () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) send({ id, type: 'data', data: head.toString('base64') });
    socket.on('data', (chunk) => send({ id, type: 'data', data: chunk.toString('base64') }));
    socket.resume();
  }, (chunk) => socket.write(chunk), () => socket.destroy());
  socket.pause(); socket.on('error', () => {});
  socket.on('close', () => { streams.delete(id); send({ id, type: 'close' }); });
});
pipe.setEncoding('utf8');
pipe.on('data', (chunk) => {
  buffer += chunk; let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const stream = streams.get(message.id);
    if (message.type === 'ready') stream?.ready();
    else if (message.type === 'data') stream?.data(Buffer.from(message.data, 'base64'));
    else if (message.type === 'close') { streams.delete(message.id); stream?.close(); }
  }
});
await new Promise((resolve) => proxy.listen(8080, '127.0.0.1', resolve));
const proxyUrl = 'http://127.0.0.1:8080';
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit', env: { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' } });
child.on('error', () => process.exit(125));
child.on('exit', (code) => process.exit(code ?? 125));
pipe.on('error', () => process.exit(125));
pipe.on('close', () => process.exit(125));
