/**
 * M6 — the client, with prediction.
 *
 * M3 demoted this file to two jobs: say which keys are held, and draw whatever
 * the server last described. That is the authoritative model at its purest and
 * it feels terrible to play, because every keypress has to travel to the
 * server and back before anything moves. M5 made that cost visible instead of
 * hiding it behind loopback.
 *
 * M6 stops waiting, without giving up any authority:
 *
 *   keydown  ──▶  move our own square NOW        (a guess, drawn solid)
 *            └─▶  send input #N to the server
 *                      ↓
 *                 server simulates, answers one round trip later
 *                      ↓
 *                 drawn as a dashed ghost, and in M6 believed but not obeyed
 *
 * Three things make that safe rather than a return to M1's cheatable client:
 * every input is NUMBERED, un-acknowledged inputs are kept in a BUFFER, and
 * the prediction runs the server's own `movePlayer` rather than a lookalike.
 *
 * What is deliberately absent: any correction of the local square. The server
 * disagreeing with us is currently drawn and ignored. Watch `drift` in the
 * corner climb and fail to return to zero - that residue is M7's entire
 * reason to exist, and papering over it now would remove the evidence.
 */

import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  MATCH_DURATION_SECONDS,
  createEmptyInput,
  movePlayer,
  type InputState,
  type Vector2,
} from '../shared/game.js';
import { GAME_PORT, parseServerMessage, type InputAck } from '../shared/protocol.js';
import { createLobby } from './lobby.js';
import { render, type ViewState } from './render.js';

const SERVER_URL = `ws://${location.hostname}:${GAME_PORT}`;

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

/**
 * Everything the renderer needs.
 *
 * `players`, `coins`, `phase` and `timeRemaining` are still never computed
 * here — they are overwritten wholesale by each snapshot. The client holds a
 * copy of the truth, never the truth.
 *
 * `predicted` is the one exception in the whole file, and it is not an
 * exception to authority: it is a guess about one square, held alongside the
 * truth rather than replacing it. The server's version of that square is still
 * in `players`, unedited, which is what lets the renderer draw both.
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
  network: { latencyMs: 0, jitterMs: 0, lossRate: 0 },
  localPlayerId: null,
  predicted: null,
  pendingInputCount: 0,
  lastAckedInput: 0,
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

/** Which keys are held right now. Sampled by the input clock, never sent raw. */
const input: InputState = createEmptyInput();

let socket: WebSocket | null = null;

/**
 * The name of the next input. Monotonic for the life of the page.
 *
 * Never reset - not between matches, not on reconnect. Its only job is to be
 * comparable, and a counter that restarts makes "newer than" ambiguous at
 * exactly the moment something has gone wrong and clarity is most needed.
 */
let nextInputSequence = 1;

interface PendingInput {
  seq: number;
  input: InputState;
  /** The step this input was predicted with. M7 replays with the same value. */
  deltaSeconds: number;
}

/**
 * Inputs sent but not yet acknowledged by the server, oldest first.
 *
 * In M6 this buffer is built, trimmed and displayed - and then not used for
 * anything. That is not an oversight. Maintaining it correctly is half the
 * work, and it lets the cost of latency be counted rather than felt: at 150ms
 * one-way and 30Hz, about nine inputs are permanently in flight. M7 is the
 * milestone that replays them.
 */
let pendingInputs: PendingInput[] = [];

/**
 * The client's guess about its own square.
 *
 * Deliberately not a `Player` and deliberately not a `GameState`. The client
 * predicts the one thing it controls: a position. It does not predict scores
 * (that would be inventing points) and it does not predict coin collection
 * (that is a contested resource the opponent may reach first). Predicting only
 * what you control is the rule that keeps prediction from quietly becoming a
 * second, cheatable simulation.
 */
let predicted: { position: Vector2 } | null = null;

/**
 * The input clock: fixed-rate, matching the server's simulation rate.
 *
 * It has to be fixed and it has to match, for the reason M4 established. The
 * server advances in steps of exactly 1/SIMULATION_HZ seconds; if the client
 * predicted with whatever delta its display happened to produce, the two would
 * compute different distances from identical inputs and drift apart even on a
 * perfect network. Same inputs plus same timestep gives the same answer.
 *
 * `setInterval` rather than `requestAnimationFrame`, which is the opposite of
 * the choice made for rendering. A hidden tab stops getting frames but its
 * socket stays open, and an input clock that stopped would leave the server
 * holding our last input - running us into a wall while we are on another tab,
 * which is precisely the M5 failure returning by a different door.
 */
const MAX_ACCUMULATED_SECONDS = 0.25;

let inputTimer: number | null = null;
let inputTickHz = 0;
let inputAccumulator = 0;
let previousInputTickAt = 0;

function sendInput(seq: number, sample: InputState): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;

  socket.send(
    JSON.stringify({
      type: 'input',
      seq,
      up: sample.up,
      down: sample.down,
      left: sample.left,
      right: sample.right,
    }),
  );
}

/**
 * One fixed step: sample the keys, name the sample, send it, predict with it.
 *
 * Note the order. The input is sent whether or not a match is running, so the
 * acknowledgement stream never goes quiet and the sequence numbers stay dense.
 * Prediction is the part that only happens while playing.
 */
function stepInput(deltaSeconds: number): void {
  const sample: InputState = { ...input };
  const seq = nextInputSequence++;

  sendInput(seq, sample);

  if (predicted === null) return;

  pendingInputs.push({ seq, input: sample, deltaSeconds });
  movePlayer(predicted, sample, deltaSeconds);

  view.predicted = { x: predicted.position.x, y: predicted.position.y };
  view.pendingInputCount = pendingInputs.length;
}

/**
 * The same accumulator the server runs, for the same reason.
 *
 * A browser timer is late constantly - more so in a background tab, where
 * Chrome throttles this to roughly once a second. The accumulator converts
 * "the timer was 400ms late" into twelve whole steps rather than one enormous
 * one, so the client generates the same number of inputs the server expects to
 * consume. The clamp is the same spiral-of-death guard, for the same reason.
 */
function onInputTimer(): void {
  const now = performance.now();
  const elapsedSeconds = (now - previousInputTickAt) / 1000;
  previousInputTickAt = now;

  const fixedDelta = 1 / inputTickHz;
  inputAccumulator += Math.min(elapsedSeconds, MAX_ACCUMULATED_SECONDS);

  while (inputAccumulator >= fixedDelta) {
    inputAccumulator -= fixedDelta;
    stepInput(fixedDelta);
  }
}

/**
 * Run the input clock at whatever rate the server reports simulating at.
 *
 * The rate is learned from snapshots rather than hard-coded, because the
 * server's rate is configurable (`--sim-hz`) and a client predicting at 30Hz
 * against a server stepping at 60Hz would be wrong in a way that looks exactly
 * like a network problem.
 */
function ensureInputClock(simulationHz: number): void {
  if (simulationHz <= 0 || simulationHz === inputTickHz) return;

  inputTickHz = simulationHz;
  if (inputTimer !== null) clearInterval(inputTimer);

  previousInputTickAt = performance.now();
  inputAccumulator = 0;
  inputTimer = window.setInterval(onInputTimer, Math.max(1, Math.round(1000 / simulationHz)));
}

/**
 * Drop the inputs the server has confirmed simulating.
 *
 * "Acknowledged" means the server has run it, not that it arrived. An input
 * that the network dropped is never acknowledged individually - it is passed
 * over when a LATER input is acknowledged, and disappears from this buffer
 * with the rest. The client never finds out which of its inputs were lost, and
 * does not need to: it only needs to know how far the server has got.
 */
function acknowledgeInputs(acks: readonly InputAck[]): void {
  const mine = acks.find((ack) => ack.playerId === view.localPlayerId);
  if (mine === undefined) return;

  view.lastAckedInput = mine.lastProcessedInput;
  pendingInputs = pendingInputs.filter((entry) => entry.seq > mine.lastProcessedInput);
  view.pendingInputCount = pendingInputs.length;
}

/**
 * Decide whether we should be predicting at all, and seed the guess if so.
 *
 * Prediction is scoped to a running match. Outside one, `update()` on the
 * server does nothing, so there is nothing to predict and the honest thing is
 * to follow the server exactly - which also avoids carrying a stale guess
 * across the match boundary, where `startMatch()` teleports everyone back to
 * their spawn point.
 *
 * And note what this function does NOT do: it never touches
 * `predicted.position` once prediction is running. The server's answer for our
 * own square arrives, is drawn as a ghost, and is otherwise ignored. That is
 * M6 by definition - correcting the guess is the whole of M7, and doing it
 * here now would be implementing a future milestone early and would hide the
 * drift that justifies it.
 */
function syncPrediction(): void {
  const me = view.players.find((player) => player.id === view.localPlayerId);

  if (me === undefined || view.phase !== 'playing') {
    predicted = null;
    pendingInputs = [];
    view.predicted = null;
    view.pendingInputCount = 0;
    return;
  }

  if (predicted === null) {
    // First snapshot of a match: start from the server's word, which is the
    // only trustworthy starting point we will ever be given.
    predicted = { position: { x: me.position.x, y: me.position.y } };
    pendingInputs = [];
    view.predicted = { x: me.position.x, y: me.position.y };
    view.pendingInputCount = 0;
  }
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

/**
 * The key handlers now only record what is held. They send nothing.
 *
 * That is the M6 inversion. Sending was previously driven by the KEYBOARD - a
 * message per change - which made the message stream as irregular as a human
 * hand and assumed every one of those rare messages arrived. It is now driven
 * by the CLOCK: a numbered input every step, describing the whole input state,
 * so a lost message is superseded 33ms later instead of stranding the server
 * on a stale "still holding D".
 *
 * The cost is honest and worth stating: ~30 messages a second per client
 * instead of a handful. That is the trade real games make, and it is why they
 * then pack several recent inputs into each packet for redundancy - noted, not
 * built, because nothing here has measured a bandwidth problem yet (rule 6).
 */
window.addEventListener('keydown', (event) => {
  if (event.repeat) return; // key-repeat cannot change a boolean that is already true
  if (applyKey(event.code, true)) event.preventDefault();
});

window.addEventListener('keyup', (event) => {
  if (applyKey(event.code, false)) event.preventDefault();
});

/**
 * Losing focus releases everything. No send needed - the next input tick
 * carries the change, because every input tick carries the full state.
 */
window.addEventListener('blur', () => {
  Object.assign(input, createEmptyInput());
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
    // M5 needed a "re-announce the current keys" hack here, because a server
    // that only hears about changes has no idea what is held at the moment you
    // connect. Sending every tick makes the question disappear: the truth is
    // on the wire a step later regardless.
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

        // Wholesale replacement, still. There is no merging and no arguing:
        // the snapshot IS the world. What M6 adds is a private guess about one
        // square held beside it - see `syncPrediction`.
        view.tick = message.tick;
        view.simulationHz = message.simulationHz;
        view.snapshotHz = message.snapshotHz;
        view.network = message.network;
        view.phase = message.phase;
        view.players = message.players;
        view.coins = message.coins;
        view.timeRemaining = message.timeRemaining;
        view.playersPerRoom = message.playersPerRoom;

        // Predict at the server's rate, learned rather than assumed.
        ensureInputClock(message.simulationHz);

        acknowledgeInputs(message.acks);
        syncPrediction();
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
   * The render loop still only draws - prediction happens on the input clock,
   * not here, so that it steps at the server's fixed rate rather than the
   * display's variable one.
   *
   * There are now FOUR clocks in play, and keeping them separate is most of
   * what M4-M6 have been about:
   *
   *   server simulation   30Hz   the world advances
   *   snapshots           10Hz   the world is described
   *   client input        30Hz   we sample, send and predict (matches the sim)
   *   render              60Hz   pixels
   *
   * The remaining choppiness belongs to the opponent, who is still drawn at
   * snapshot rate: 10 updates a second painted 60 times means each position is
   * held for six frames. M8's interpolation is the answer, and it is now the
   * only obviously-bad-looking thing left on screen.
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
