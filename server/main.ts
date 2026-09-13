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
  type ClientMessage,
  type ServerMessage,
} from '../shared/protocol.js';
import {
  createLink,
  describeConditions,
  isDegraded,
  PERFECT_NETWORK,
  type NetworkConditions,
} from './network-simulator.js';

/**
 * Settings come from a CLI flag or an environment variable, flag winning.
 *
 * Both, because neither works everywhere: `SIM_HZ=60 npm run game` is natural
 * in bash and simply not valid syntax in PowerShell, while
 * `npm run game -- --sim-hz 60` works in both. Someone following this project
 * on Windows should not have to discover that on their own.
 */
function setting(flag: string, envName: string): string | undefined {
  const index = process.argv.indexOf(`--${flag}`);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }
  return process.env[envName];
}

function numberSetting(
  flag: string,
  envName: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = setting(flag, envName);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(
      `[warn]  ignoring --${flag}=${raw} (expected ${min}..${max}); using ${fallback}`,
    );
    return fallback;
  }
  return value;
}

function rateFromEnv(name: string, fallback: number): number {
  const flag = name === 'SIM_HZ' ? 'sim-hz' : 'snapshot-hz';
  return numberSetting(flag, name, fallback, { min: 1, max: 240 });
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

/**
 * The artificial network. Perfect unless asked otherwise.
 *
 *   npm run game -- --latency 100 --jitter 20 --loss 0.05
 *
 * Applied to every connection, in both directions. This exists to make the
 * lag that has always been there VISIBLE - nothing here fixes anything, and
 * nothing should until M6.
 */
const NETWORK: NetworkConditions = {
  latencyMs: numberSetting('latency', 'LATENCY_MS', PERFECT_NETWORK.latencyMs, {
    min: 0,
    max: 2000,
  }),
  jitterMs: numberSetting('jitter', 'JITTER_MS', PERFECT_NETWORK.jitterMs, {
    min: 0,
    max: 1000,
  }),
  lossRate: numberSetting('loss', 'LOSS', PERFECT_NETWORK.lossRate, { min: 0, max: 1 }),
};

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
  /** Server -> this client, through the artificial network. Carries bytes. */
  outbound: ReturnType<typeof createLink<string>>;
  /** This client -> server, through the artificial network. Carries parsed messages. */
  inbound: ReturnType<typeof createLink<ClientMessage>>;
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

/**
 * Put bytes on the wire immediately. Only the network simulator calls this.
 */
function deliverNow(socket: WebSocket, payload: string): void {
  // The socket may have closed while this message was in flight.
  if (socket.readyState !== socket.OPEN) return;
  socket.send(payload);
}

/**
 * Send to one client, through the artificial network.
 *
 * The message is serialised HERE, before it enters the link - not on delivery.
 * That distinction is the whole difference between a delayed message and a
 * delayed reference.
 *
 * The first version of this passed the message object to the link and let the
 * delivery callback stringify it 200ms later. But a snapshot holds
 * `state.players`, which is the server's live array - so by the time it was
 * serialised the positions had moved on, and every "delayed" snapshot arrived
 * carrying fresh data. Latency delayed WHEN the client heard, but not WHAT it
 * heard, and a measured round trip came out at half its real cost.
 *
 * Once bytes are on a real wire they are frozen. Serialising at send time is
 * what makes this simulator honest.
 *
 * Snapshots are droppable; the handshake is not. A lost snapshot is superseded
 * by the next one a tenth of a second later, which is exactly the bet real
 * games make when they send state unreliably. A lost `welcome` would leave a
 * client that never learns its own id.
 */
function send(socket: WebSocket, message: ServerMessage): void {
  const payload = JSON.stringify(message);
  const connection = connections.get(socket);

  if (connection === undefined) {
    // No connection record yet - a refusal sent before the player was seated.
    deliverNow(socket, payload);
    return;
  }

  connection.outbound.carry(payload, message.type === 'snapshot' ? 'droppable' : 'reliable');
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
    network: {
      latencyMs: NETWORK.latencyMs,
      jitterMs: NETWORK.jitterMs,
      lossRate: NETWORK.lossRate,
    },
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

/**
 * Act on one message from one client.
 *
 * Called by the inbound link, which means it may run long after the frame
 * actually arrived - or never, if the simulator dropped it. Parsing happens
 * before the link, so malformed frames are rejected at arrival rather than
 * being carefully delayed and then thrown away.
 */
function handleClientMessage(socket: WebSocket, message: ClientMessage): void {
  const connection = connections.get(socket);
  if (connection === undefined) return;

  if (message.type === 'ready') {
    setReady(state, connection.playerId, message.ready);
    console.log(
      `[lobby] player ${connection.playerId} is ${message.ready ? 'ready' : 'not ready'}`,
    );
    startMatchIfEveryoneIsReady();
    broadcastSnapshot();
    return;
  }

  /**
   * The input is recorded, not acted upon. It will be applied by the next
   * tick, along with everyone else's, so no player gains an advantage by
   * sending more messages per second than anyone else.
   *
   * M5 note: this map is the planted bug. The server keeps the last input it
   * heard and reapplies it every tick until told otherwise - so if the message
   * saying "I released D" is the one the simulator drops, this player keeps
   * running right until their next keypress.
   */
  latestInputs.set(connection.playerId, {
    up: message.up,
    down: message.down,
    left: message.left,
    right: message.right,
  });
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

  // Two one-way links: what we send them, and what they send us. Real latency
  // is paid in both directions, which is why a round trip costs twice it.
  const outbound = createLink<string>(
    () => NETWORK,
    (payload) => deliverNow(socket, payload),
  );
  const inbound = createLink<ClientMessage>(
    () => NETWORK,
    (message) => handleClientMessage(socket, message),
  );

  connections.set(socket, { socket, playerId, outbound, inbound });
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
      console.warn(`[warn]  player ${connection.playerId} sent an unusable message`);
      return;
    }

    /**
     * Only `input` is droppable, matching the outbound rule where only
     * snapshots are.
     *
     * The first version dropped everything a client sent, which meant a lost
     * `ready` press left the lobby waiting forever with no way to retry
     * short of clicking again - and at 40% loss, a test hung outright. Real
     * games run lobby and control traffic on a reliable channel precisely
     * because there is no next message along to supersede a lost one.
     */
    connection.inbound.carry(message, message.type === 'input' ? 'droppable' : 'reliable');
  });

  socket.on('close', (code) => {
    const connection = connections.get(socket);
    if (connection === undefined) return;

    // Anything still in flight is now undeliverable; cancel the timers rather
    // than let them fire against a dead socket and hold the process open.
    connection.outbound.cancelAll();
    connection.inbound.cancelAll();

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
  console.log(`Network:    ${describeConditions(NETWORK)}`);
  if (!isDegraded(NETWORK)) {
    console.log('');
    console.log('  Loopback is not a network. To feel what M6-M8 are for:');
    console.log('    npm run game -- --latency 100');
    console.log('    npm run game -- --latency 150 --jitter 30 --loss 0.05');
  }
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
