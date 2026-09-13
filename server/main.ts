/**
 * M3 — the authoritative server.
 *
 * The whole milestone in one sentence: this process owns the game, and the
 * browsers are terminals attached to it.
 *
 *   client  --{ input }-->  SERVER (simulates, decides)  --{ snapshot }-->  clients
 *
 * What the server owns: player positions, coin positions, who collected what,
 * scores, the match clock, and the phase. What a client owns: which keys its
 * user is holding, and nothing else whatsoever.
 *
 * Deliberately NOT here yet:
 *  - a fixed timestep (M4) - this loop uses a measured delta, which is honest
 *    but not reproducible, and M4 explains why that matters;
 *  - tick numbers on snapshots (M4);
 *  - anything resembling prediction (M6). The lag you feel playing this is the
 *    entire motivation for M5-M7 and must not be papered over now.
 *
 * Run: npm run build && npm run game
 */

import { networkInterfaces } from 'node:os';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  PLAYERS_PER_ROOM,
  addPlayer,
  clearReady,
  createInitialState,
  everyoneIsReady,
  refreshLobbyPhase,
  removePlayer,
  setReady,
  startMatch,
  update,
  type GameState,
  type InputState,
  type PlayerId,
} from '../shared/game.js';
import {
  GAME_PORT,
  parseClientMessage,
  type ServerMessage,
} from '../shared/protocol.js';

/**
 * How often the server advances the world and describes it.
 *
 * In M4 these become two separate numbers - a simulation that ticks at one
 * rate and snapshots that go out at another - because they answer different
 * questions. For now one interval does both, which is the simplest thing that
 * can possibly work and therefore the right thing to start from.
 */
const TICK_INTERVAL_MS = 50; // 20 Hz

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

interface Connection {
  socket: WebSocket;
  playerId: PlayerId;
}

/**
 * A single room. One match, at most PLAYERS_PER_ROOM players.
 *
 * Matchmaking, lobbies and multiple concurrent rooms are all out of scope -
 * they are product features, not networking lessons. One hard-coded room is
 * enough to exercise every idea in the roadmap.
 */
const state: GameState = createInitialState();
const connections = new Map<WebSocket, Connection>();

/**
 * The latest input received from each player, keyed by id.
 *
 * The server keeps the LAST input it heard and reapplies it every tick until
 * told otherwise. Clients send only on change, so this map is what turns
 * occasional "I started holding RIGHT" messages into continuous movement.
 *
 * The flaw is deliberate and worth remembering: if the packet saying "I let go
 * of RIGHT" is lost, this server will happily run that player into the wall
 * forever. Nothing loses packets on localhost, so the bug is invisible until
 * M5 introduces packet loss on purpose - which is exactly the sort of failure
 * the plan wants demonstrated before it is fixed.
 */
const latestInputs = new Map<PlayerId, InputState>();

let nextPlayerId: PlayerId = 1;

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  for (const socket of connections.keys()) send(socket, message);
}

/**
 * Describe the world to everyone.
 *
 * Every client receives the SAME snapshot - there is no per-player view of the
 * truth. (That changes in M12's lag compensation, where the server has to
 * reason about what each client was seeing at the moment it acted.)
 */
function broadcastSnapshot(): void {
  broadcast({
    type: 'snapshot',
    phase: state.phase,
    players: state.players,
    coins: state.coins,
    timeRemaining: state.timeRemaining,
    playersPerRoom: PLAYERS_PER_ROOM,
  });
}

/**
 * Start the match if, and only if, every seat is filled and every player has
 * said they are ready.
 *
 * Called after anything that could change the answer - a join, a leave, a
 * ready toggle. One function, one decision point: the alternative is three
 * call sites each deciding for themselves and eventually disagreeing.
 */
function startMatchIfEveryoneIsReady(): void {
  if (state.phase !== 'lobby' && state.phase !== 'finished') return;
  if (!everyoneIsReady(state)) return;

  startMatch(state);
  console.log('[match] both players ready - started');
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/**
 * `host: '0.0.0.0'` binds every network interface, not just the loopback, so
 * another device on the same Wi-Fi can reach this. It is the default for `ws`,
 * but stating it makes the intent - and the security posture - explicit: this
 * is a LAN-visible server with no authentication, which is fine for a trusted
 * home network and would not be fine anywhere else.
 */
const server = new WebSocketServer({ port: GAME_PORT, host: '0.0.0.0' });

server.on('connection', (socket) => {
  if (connections.size >= PLAYERS_PER_ROOM) {
    // Refuse politely, then hang up. A third browser must not be able to join
    // a two-player match just because it knows the address.
    send(socket, { type: 'room_full' });
    socket.close(1000, 'room full');
    console.log('[join]  refused - room full');
    return;
  }

  const playerId = nextPlayerId++;
  connections.set(socket, { socket, playerId });
  addPlayer(state, playerId);
  latestInputs.set(playerId, { up: false, down: false, left: false, right: false });

  console.log(`[join]  player ${playerId} (${connections.size}/${PLAYERS_PER_ROOM})`);
  send(socket, { type: 'welcome', playerId });

  // Filling the room no longer starts the match - it opens the lobby, and the
  // humans decide when to begin. `update()` does nothing outside 'playing', so
  // nobody can collect anything while the lobby is open.
  refreshLobbyPhase(state);
  if (state.phase === 'lobby') console.log('[lobby] room full - waiting for ready');
  broadcastSnapshot();

  socket.on('message', (data) => {
    const connection = connections.get(socket);
    if (connection === undefined) return;

    const message = parseClientMessage(data.toString());
    if (message === null) {
      // Ignore, do not disconnect. Garbage from one client is not the other
      // player's problem, and a parser that throws here would end the match.
      console.warn(`[warn]  player ${connection.playerId} sent an unusable message`);
      return;
    }

    if (message.type === 'ready') {
      setReady(state, connection.playerId, message.ready);
      console.log(
        `[lobby] player ${connection.playerId} is ` +
          `${message.ready ? 'ready' : 'not ready'}`,
      );
      startMatchIfEveryoneIsReady();
      broadcastSnapshot();
      return;
    }

    // The input is recorded, not acted upon. It will be applied by the next
    // tick, along with everyone else's, so no player gains an advantage by
    // sending more messages per second than anyone else.
    latestInputs.set(connection.playerId, {
      up: message.up,
      down: message.down,
      left: message.left,
      right: message.right,
    });
  });

  socket.on('close', (code) => {
    const connection = connections.get(socket);
    if (connection === undefined) return;

    connections.delete(socket);
    removePlayer(state, connection.playerId);
    latestInputs.delete(connection.playerId);

    console.log(
      `[leave] player ${connection.playerId} (code ${code}) - ` +
        `${connections.size}/${PLAYERS_PER_ROOM} remain`,
    );

    // A match cannot continue one-sided. The remaining player drops back to
    // waiting, with ready flags cleared so nobody is accidentally still armed
    // when a new opponent arrives.
    const wasPlaying = state.phase === 'playing';
    refreshLobbyPhase(state);
    clearReady(state);
    if (wasPlaying && state.phase !== 'playing') {
      console.log('[match] abandoned - waiting for a second player');
    }

    broadcastSnapshot();
  });

  // Without this, one socket error takes down the process and with it the
  // other player's match.
  socket.on('error', (error) => {
    console.error(`[error] player ${playerId}: ${error.message}`);
  });
});

/** Every non-internal IPv4 address this machine answers on. */
function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

server.on('listening', () => {
  console.log(`Game server listening on ws://0.0.0.0:${GAME_PORT}`);
  console.log(`Simulating at ${Math.round(1000 / TICK_INTERVAL_MS)} Hz`);
  for (const address of localAddresses()) {
    console.log(`  reachable on this network at ws://${address}:${GAME_PORT}`);
  }
});

// ---------------------------------------------------------------------------
// The server loop
// ---------------------------------------------------------------------------

/**
 * `setInterval` does not promise to fire on time - it promises not to fire
 * early. Under load the gap between ticks stretches, so the delta is MEASURED
 * rather than assumed to be TICK_INTERVAL_MS.
 *
 * This is still a variable timestep, and therefore still not reproducible:
 * replaying the same inputs will not reproduce the same positions, because the
 * deltas will differ. Nothing in M3 needs reproducibility. Prediction does,
 * which is why M4 replaces this with a fixed timestep before M6 arrives.
 */
let previousTickAt = process.hrtime.bigint();

setInterval(() => {
  const now = process.hrtime.bigint();
  const deltaSeconds = Number(now - previousTickAt) / 1_000_000_000;
  previousTickAt = now;

  update(state, latestInputs, Math.min(deltaSeconds, 0.1));
  broadcastSnapshot();
}, TICK_INTERVAL_MS);
