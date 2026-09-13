/**
 * M2 — the WebSocket toy. A chat broadcast server, and nothing else.
 *
 * The plan is emphatic that this must NOT be the game:
 *
 *   > Pause work on the game temporarily. Build a tiny networking experiment
 *   > unrelated to the game.
 *
 * The point is to meet `open` / `message` / `close` / `error` and broadcasting
 * while nothing else can be the thing that's broken. When M3 misbehaves, the
 * socket will already be the part you trust.
 *
 * Plain JavaScript rather than TypeScript, like `tools/dev-server.mjs`: this is
 * throwaway experiment code, and the real typed server arrives in M3.
 *
 * Run: npm run chat        (then open http://localhost:5173/experiments/websocket-toy/)
 */

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.CHAT_PORT ?? 8080);

/**
 * The server's own view of who is connected.
 *
 * A WebSocket connection is a long-lived object, not a request that ends, so
 * the server has somewhere to keep per-connection facts. That is the whole
 * shift from HTTP: identity lives in the connection instead of being re-proved
 * on every message. `clients` here is the ancestor of M3's room of players.
 */
const clients = new Map(); // socket -> { id, name }

let nextClientId = 1;

const server = new WebSocketServer({ port: PORT });

/** Every message on the wire is JSON with a `type` field. */
function send(socket, message) {
  // A socket can close between deciding to send and actually sending.
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

/**
 * Send to everyone, optionally excluding one socket.
 *
 * This loop is the entire reason a server exists in a multiplayer game: A's
 * message reaches B without B ever asking for it. HTTP cannot do that — the
 * client would have to poll and ask "anything new?" over and over.
 */
function broadcast(message, exclude = null) {
  for (const socket of clients.keys()) {
    if (socket !== exclude) send(socket, message);
  }
}

function describeClients() {
  return [...clients.values()].map((client) => client.name);
}

server.on('connection', (socket, request) => {
  const id = nextClientId++;
  const name = `Client ${id}`;
  clients.set(socket, { id, name });

  console.log(
    `[open]  ${name} connected from ${request.socket.remoteAddress} ` +
      `(${clients.size} online)`,
  );

  // 1. Tell the newcomer who they are. The client does not choose its own
  //    identity — the server assigns it. That rule is small here and becomes
  //    the central principle of M3.
  send(socket, { type: 'welcome', id, name, online: describeClients() });

  // 2. Tell everyone else that someone arrived.
  broadcast({ type: 'presence', event: 'join', name, online: describeClients() }, socket);

  socket.on('message', (data) => {
    // `data` is a Buffer, not a string. Text frames still arrive as bytes, and
    // in M12 we will deliberately send binary ones instead.
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      console.warn(`[warn]  ${name} sent malformed JSON`);
      send(socket, { type: 'error', message: 'Messages must be JSON.' });
      return;
    }

    if (parsed.type !== 'chat' || typeof parsed.message !== 'string') {
      send(socket, { type: 'error', message: `Unknown message type: ${parsed.type}` });
      return;
    }

    console.log(`[msg]   ${name}: ${parsed.message}`);

    // Broadcast to everyone INCLUDING the sender. Letting the server echo the
    // message back, rather than the sender drawing it locally, means every
    // client renders the same list in the same order decided by one machine.
    // That is the shape of an authoritative server, rehearsed in miniature.
    broadcast({
      type: 'chat',
      from: name,
      fromId: id,
      message: parsed.message,
      sentAt: Date.now(),
    });
  });

  socket.on('close', (code, reason) => {
    clients.delete(socket);
    console.log(
      `[close] ${name} disconnected (code ${code}` +
        `${reason.length ? `, "${reason}"` : ''}) — ${clients.size} online`,
    );
    broadcast({ type: 'presence', event: 'leave', name, online: describeClients() });
  });

  // Without this handler, a socket error would be an unhandled 'error' event
  // and would crash the process. A disconnecting client must never be able to
  // take the server down with it.
  socket.on('error', (error) => {
    console.error(`[error] ${name}: ${error.message}`);
  });
});

server.on('listening', () => {
  console.log(`Chat server listening on ws://localhost:${PORT}`);
});

server.on('error', (error) => {
  console.error('[server error]', error.message);
});
