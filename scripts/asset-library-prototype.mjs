// Disposable #38 preview server. It never starts Frameboard or opens its database.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
if (process.env.NODE_ENV === 'production') throw new Error('This disposable prototype is for local review only.');
const port = Number(process.env.PORT || 3038);
const page = new URL('../public/asset-library-prototype.html', import.meta.url);
createServer(async (request, response) => {
  if (!['/', '/asset-library-prototype.html'].includes(new URL(request.url, 'http://localhost').pathname)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(await readFile(page));
}).listen(port, '127.0.0.1', () => console.log(`Asset library prototype: http://localhost:${port}/asset-library-prototype.html?variant=C`));
