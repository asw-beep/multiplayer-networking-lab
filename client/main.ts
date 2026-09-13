/**
 * M3 — the client.
 *
 * Compare this with M1 and notice what is missing: there is no call to
 * `update()` anywhere in this file. The client has been demoted from
 * simulating the game to two jobs:
 *
 *   1. tell the server which keys are held
 *   2. draw whatever the server last said the world looks like
 *
 * That is the authoritative model in its purest, most naive form, and it will
 * feel bad to play — every keypress has to travel to the server and the result
 * has to travel back before anything moves on screen. Locally that round trip
 * is ~0ms and the lag hides. M5 adds artificial latency to expose it, and M6
 * fixes it properly with prediction.
 */

import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  MATCH_DURATION_SECONDS,
  createEmptyInput,
  type InputState,
} from '../shared/game.js';
import { GAME_PORT, parseServerMessage } from '../shared/protocol.js';
import { createLobby } from './lobby.js';
import { render, type ViewState } from './render.js';

const SERVER_URL = `ws://${location.hostname}:${GAME_PORT}`;

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

/**
 * Everything the renderer needs. Note that `players`, `coins`, `phase` and
 * `timeRemaining` are never computed here — they are overwritten wholesale by
 * each snapshot. The client holds a *copy* of the truth, never the truth.
 */
const view: ViewState = {
  phase: 'waiting',
  players: [],
  coins: [],
  timeRemaining: MATCH_DURATION_SECONDS,
  tick: 0,
  simulationHz: 0,
  snapshotHz: 0,
  measuredSnapshotHz: 0,
  measuredRenderHz: 0,
  localPlayerId: null,
  playersPerRoom: 2,
  connection: 'connecting',
};

/**
 * Counters for the measured rates. The server REPORTS what it intends to do;
 * these count what actually arrived and what was actually drawn, which is not
 * automatically the same thing - and under M5's artificial packet loss it will
 * very deliberately not be.
 *
 * They are measured on two DIFFERENT clocks, which is the M4 lesson applied to
 * the instrumentation itself:
 *
 *   snapshots arrive on the network's clock  -> counted against setInterval
 *   frames are drawn on the display's clock  -> counted inside rAF
 *
 * Using rAF for both would have been wrong, and visibly so: a backgrounded tab
 * stops getting frames while snapshots keep arriving, and the readout would
 * have claimed zero snapshots when the socket was still busy.
 */
let snapshotsSinceLastCount = 0;
let framesSinceLastCount = 0;
let frameWindowStartedAt = 0;

/** Updated by `main()` once the lobby DOM is wired up. */
let updateLobby: (view: ViewState) => void = () => {};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const input: InputState = createEmptyInput();

/** The last input actually sent, so we can tell when it changed. */
let lastSentInput: InputState = createEmptyInput();

let socket: WebSocket | null = null;

function inputChanged(a: InputState, b: InputState): boolean {
  return a.up !== b.up || a.down !== b.down || a.left !== b.left || a.right !== b.right;
}

/**
 * Send only when the held keys change, rather than every frame.
 *
 * At 60fps an unconditional send would be 60 messages a second per client to
 * describe four booleans that change a handful of times. Sending on change is
 * the obvious economy — and it quietly assumes every message arrives, because
 * the server holds the last input it heard until told otherwise. Lose the
 * "I released D" message and that player runs at the wall until the next
 * keypress. Nothing on localhost loses messages, so this stays invisible until
 * M5 introduces packet loss deliberately. M6 replaces the whole scheme with
 * per-tick numbered inputs.
 */
function sendInputIfChanged(): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;
  if (!inputChanged(input, lastSentInput)) return;

  socket.send(
    JSON.stringify({
      type: 'input',
      up: input.up,
      down: input.down,
      left: input.left,
      right: input.right,
    }),
  );

  lastSentInput = { ...input };
}

function applyKey(code: string, isDown: boolean): boolean {
  switch (code) {
    case 'KeyW':
    case 'ArrowUp':
      input.up = isDown;
      return true;
    case 'KeyS':
    case 'ArrowDown':
      input.down = isDown;
      return true;
    case 'KeyA':
    case 'ArrowLeft':
      input.left = isDown;
      return true;
    case 'KeyD':
    case 'ArrowRight':
      input.right = isDown;
      return true;
    default:
      return false;
  }
}

window.addEventListener('keydown', (event) => {
  if (event.repeat) return; // key-repeat cannot change a boolean that is already true
  if (applyKey(event.code, true)) {
    event.preventDefault();
    sendInputIfChanged();
  }
});

window.addEventListener('keyup', (event) => {
  if (applyKey(event.code, false)) {
    event.preventDefault();
    sendInputIfChanged();
  }
});

/** Losing focus must release everything — and the server must be told. */
window.addEventListener('blur', () => {
  Object.assign(input, createEmptyInput());
  sendInputIfChanged();
});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function connect(): void {
  view.connection = 'connecting';
  socket = new WebSocket(SERVER_URL);

  socket.addEventListener('open', () => {
    view.connection = 'open';
    updateLobby(view);
    // Re-announce the current keys: the server starts us at "nothing held",
    // which is only true if nobody is holding anything right now.
    lastSentInput = { up: true, down: true, left: true, right: true };
    sendInputIfChanged();
  });

  socket.addEventListener('message', (event) => {
    const message = parseServerMessage(String(event.data));
    if (message === null) return;

    switch (message.type) {
      case 'welcome':
        view.localPlayerId = message.playerId;
        break;

      case 'room_full':
        view.connection = 'refused';
        break;

      case 'snapshot':
        /**
         * Reject anything not newer than what we already have.
         *
         * Over a WebSocket this can never fire: TCP delivers in order, so a
         * snapshot cannot overtake an older one. It is here because the guard
         * has to exist before the thing it guards against does - M5 adds a
         * network simulator that reorders and drops deliberately, and M12
         * looks at UDP, where out-of-order delivery is normal rather than
         * impossible.
         *
         * Drawing a stale snapshot would make players visibly jump backwards.
         */
        if (message.tick <= view.tick && view.tick !== 0) return;

        snapshotsSinceLastCount += 1;

        // Wholesale replacement. There is no merging, no reconciling, no
        // arguing with the server - in M3 the snapshot simply IS the world.
        view.tick = message.tick;
        view.simulationHz = message.simulationHz;
        view.snapshotHz = message.snapshotHz;
        view.phase = message.phase;
        view.players = message.players;
        view.coins = message.coins;
        view.timeRemaining = message.timeRemaining;
        view.playersPerRoom = message.playersPerRoom;
        break;
    }

    // The lobby is snapshot-driven like everything else: it redraws when the
    // server says something changed, not on a timer of its own.
    updateLobby(view);
  });

  socket.addEventListener('close', () => {
    if (view.connection !== 'refused') view.connection = 'closed';
    socket = null;
    updateLobby(view);
  });

  socket.addEventListener('error', () => {
    // No detail available by design; `close` follows and reports the outcome.
  });
}

// ---------------------------------------------------------------------------
// Boot + render loop
// ---------------------------------------------------------------------------

function main(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#game');
  if (canvas === null) throw new Error('Canvas element #game not found');

  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Could not get a 2D rendering context');

  canvas.width = ARENA_WIDTH;
  canvas.height = ARENA_HEIGHT;

  updateLobby = createLobby({
    onToggleReady: (ready) => {
      if (socket === null || socket.readyState !== WebSocket.OPEN) return;
      // A request, not a command. The server decides whether this starts a match.
      socket.send(JSON.stringify({ type: 'ready', ready }));
    },
  });
  updateLobby(view);

  connect();

  /**
   * The render loop still runs at display rate, but it no longer advances
   * anything — it only draws the latest snapshot. Two clocks are now visible
   * in one file: this one, and the server's tick rate, which is slower.
   *
   * That mismatch is why remote players look choppy: 20 server updates a
   * second being drawn 60 times a second means each position is drawn three
   * times before it changes. M8's interpolation is the answer.
   */
  // Snapshot arrival, counted on a timer that keeps running when the tab is
  // hidden - because the socket does too.
  let lastSnapshotCountAt = performance.now();
  setInterval(() => {
    const now = performance.now();
    const seconds = (now - lastSnapshotCountAt) / 1000;
    lastSnapshotCountAt = now;
    if (seconds > 0) view.measuredSnapshotHz = snapshotsSinceLastCount / seconds;
    snapshotsSinceLastCount = 0;
  }, 1000);

  const frame = (timestamp: number): void => {
    framesSinceLastCount += 1;

    // Frames, counted where frames actually happen.
    if (frameWindowStartedAt === 0) frameWindowStartedAt = timestamp;
    const windowSeconds = (timestamp - frameWindowStartedAt) / 1000;
    if (windowSeconds >= 1) {
      view.measuredRenderHz = framesSinceLastCount / windowSeconds;
      framesSinceLastCount = 0;
      frameWindowStartedAt = timestamp;
    }

    render(context, view);
    requestAnimationFrame(frame);
  };

  render(context, view);
  requestAnimationFrame(frame);
}

main();

/**
 * A window on the client's copy of the world, for the devtools console.
 *
 * Reading state is the only thing it allows - there is no setter here, and
 * there must never be one, because anything a console can change a cheat can
 * change. This is the seed of M11's diagnostics panel.
 */
declare global {
  interface Window {
    lab: { view: () => ViewState };
  }
}

window.lab = { view: () => structuredClone(view) };
