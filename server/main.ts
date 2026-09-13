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
 * M4 added the two clocks. The world advances in FIXED steps at
 * SIMULATION_HZ, and snapshots go out separately at SNAPSHOT_HZ. Both are
 * configurable so the difference can be felt rather than argued about:
 *
 *   SIM_HZ=5 npm run game        the world updates in visible lurches
 *   SNAPSHOT_HZ=2 npm run game   the world is smooth; nobody is told in time
 *
 * Deliberately NOT here yet:
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

function rateFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 240) {
    console.warn(`[warn]  ignoring ${name}=${raw}; using ${fallback} Hz`);
    return fallback;
  }
  return value;
}

/**
 * How often the world advances. Every step is exactly 1/SIMULATION_HZ seconds
 * of simulated time, regardless of how late the timer actually fired.
 */
const SIMULATION_HZ = rateFromEnv('SIM_HZ', 30);

/**
 * How often clients are told about it. Lower than the simulation rate on
 * purpose: describing the world is the expensive part - it costs a full
 * serialised copy per client per snapshot - while advancing it is cheap.
 */
const SNAPSHOT_HZ = rateFromEnv('SNAPSHOT_HZ', 10);

/** Seconds of simulated time per step. The only delta `update()` ever sees. */
const FIXED_DELTA_SECONDS = 1 / SIMULATION_HZ;

/**
 * The spiral-of-death guard.
 *
 * If the process stalls - GC, a laptop lid, a debugger - the accumulator would
 * hold seconds of unsimulated time and the catch-up loop would try to run
 * hundreds of steps at once. That takes longer than real time, so the next
 * frame is even further behind, and the server never recovers. Discarding the
 * excess makes the world briefly run slow, which is survivable; the spiral is
 * not.
 */
const MAX_ACCUMULATED_SECONDS = 0.25;

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
    tick: state.tick,
    phase: state.phase,
    players: state.players,
    coins: state.coins,
    timeRemaining: state.timeRemaining,
    playersPerRoom: PLAYERS_PER_ROOM,
    simulationHz: SIMULATION_HZ,
    snapshotHz: SNAPSHOT_HZ,
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
/** Overridable so a second server can be run alongside the normal one. */
const PORT = Number(process.env['GAME_PORT'] ?? GAME_PORT);

const server = new WebSocketServer({ port: PORT, host: '0.0.0.0' });

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
  console.log(`Game server listening on ws://0.0.0.0:${PORT}`);
  console.log(
    `Simulation ${SIMULATION_HZ} Hz (${(FIXED_DELTA_SECONDS * 1000).toFixed(1)}ms/step)` +
      `  |  snapshots ${SNAPSHOT_HZ} Hz`,
  );
  console.log('  override with SIM_HZ / SNAPSHOT_HZ');
  for (const address of localAddresses()) {
    console.log(`  reachable on this network at ws://${address}:${PORT}`);
  }
});

/**
 * Server-level failures, as opposed to one connection's failures.
 *
 * Without this handler an 'error' here is unhandled and Node exits with a
 * stack trace, which tells a reader nothing about what to do. The common case
 * by far is a stale server still holding the port after a restart, so say so.
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`
Port ${PORT} is already in use.`);
    console.error('Another game server is probably still running. Either stop it,');
    console.error(`or start this one elsewhere:  GAME_PORT=8082 npm run game
`);
    process.exit(1);
  }

  console.error('[server error]', error.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// The server loop
// ---------------------------------------------------------------------------

/**
 * The fixed-timestep loop.
 *
 * The problem with M3's loop was not that it was inaccurate - it measured the
 * real delta honestly. The problem is that it was not REPRODUCIBLE. Feed the
 * same inputs in twice and you get different positions, because the deltas
 * differ by a millisecond here and there. That is fine when one machine owns
 * the answer and nobody checks its work.
 *
 * It stops being fine in M6/M7, where the client runs this same simulation to
 * predict its own movement and then replays inputs to reconcile. Prediction is
 * only useful if the client can arrive at the SAME number the server will.
 * Identical inputs plus identical timesteps give identical results; identical
 * inputs plus whatever-the-timer-did do not.
 *
 * So: real elapsed time goes into an accumulator, and the world is advanced in
 * whole steps of exactly FIXED_DELTA_SECONDS until less than one step remains.
 * The timer being late no longer changes the physics - it only changes how
 * many steps run in one pass.
 *
 *   accumulator += elapsed
 *   while (accumulator >= dt) { update(dt); accumulator -= dt }
 *
 * This is Gaffer On Games' "Fix Your Timestep", minus the interpolation of the
 * leftover remainder - that belongs on the client, in M8.
 */
let previousTickAt = process.hrtime.bigint();
let accumulator = 0;

setInterval(
  () => {
    const now = process.hrtime.bigint();
    const elapsedSeconds = Number(now - previousTickAt) / 1_000_000_000;
    previousTickAt = now;

    accumulator += Math.min(elapsedSeconds, MAX_ACCUMULATED_SECONDS);

    while (accumulator >= FIXED_DELTA_SECONDS) {
      update(state, latestInputs, FIXED_DELTA_SECONDS);
      accumulator -= FIXED_DELTA_SECONDS;
    }
  },
  Math.max(1, Math.round(1000 / SIMULATION_HZ)),
);

/**
 * Snapshots, on their own clock.
 *
 * This is the separation M4 exists to demonstrate. The world can advance 30
 * times a second while clients hear about it 10 times a second - and the
 * client's screen refreshes 60 times a second on top of that. Three rates,
 * three different reasons, and no reason for any of them to match.
 *
 * Lower the snapshot rate and the simulation stays perfectly correct; it is
 * the clients' picture of it that gets coarse. That is the whole argument for
 * interpolation in M8: the missing information is not missing from the world,
 * only from the description of it.
 */
setInterval(broadcastSnapshot, Math.max(1, Math.round(1000 / SNAPSHOT_HZ)));
