/**
 * Minimal static file server for local development.
 *
 * Deliberately hand-written and dependency-free:
 *  - the project's whole point is understanding what happens on the wire,
 *    so the dev server should not be a black box either;
 *  - we need Node + the `http` module anyway once the game server arrives (M2+),
 *    so this is the same `createServer` API we will meet again.
 *
 * Usage: npm run serve   (or: node tools/dev-server.mjs)
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 5173);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function resolveRequestedFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);

  // A path ending in '/' names a directory, and directories are served by
  // their index.html - the same convention every static host uses. Without
  // this, '/experiments/websocket-toy/' resolves to a directory and 404s.
  const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const absolute = resolve(join(ROOT, relative));

  // Never serve anything outside the project directory.
  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) return null;
  return absolute;
}

const server = createServer(async (req, res) => {
  const filePath = resolveRequestedFile(req.url ?? '/');

  if (filePath === null) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error('directory');

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      // Always re-fetch: a stale cached bundle during a networking experiment
      // is a debugging rabbit hole we do not need.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

/** Every non-internal IPv4 address this machine answers on. */
function localAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

// '0.0.0.0' binds every interface rather than just loopback, so phones and
// laptops on the same Wi-Fi can load the page. No auth, no TLS - a trusted
// local network only.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dev server running, serving ${ROOT}`);
  console.log(`  this machine:  http://localhost:${PORT}/`);

  const addresses = localAddresses();
  if (addresses.length === 0) {
    console.log('  no LAN address found - is this machine on a network?');
  } else {
    for (const address of addresses) {
      console.log(`  same network:  http://${address}:${PORT}/`);
    }
    console.log('');
    console.log('Open the "same network" address on the other device.');
    console.log('On Windows, allow Node through the firewall if prompted.');
  }
});
