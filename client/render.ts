/**
 * Drawing. Reads state, writes pixels, changes nothing.
 *
 * In M3 the state it draws is no longer local — it is whatever the last
 * snapshot from the server said. The renderer neither knows nor cares that the
 * data arrived over a socket, which is why it barely changed from M1.
 */

import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  COIN_RADIUS,
  PLAYER_SIZE,
  type Coin,
  type MatchPhase,
  type Player,
  type PlayerId,
  type Vector2,
} from '../shared/game.js';

export interface ViewState {
  phase: MatchPhase;
  players: Player[];
  coins: Coin[];
  timeRemaining: number;
  /** The simulation step the last accepted snapshot described. */
  tick: number;
  /** Server rates, reported in each snapshot so the client can display them. */
  simulationHz: number;
  snapshotHz: number;
  /** Snapshots actually accepted in the last second, measured by the client. */
  measuredSnapshotHz: number;
  /** Frames drawn in the last second. */
  measuredRenderHz: number;
  /** Artificial network conditions the server reports it is applying. */
  network: { latencyMs: number; jitterMs: number; lossRate: number };
  /** Which player the local browser is controlling, once the server has said. */
  localPlayerId: PlayerId | null;
  /**
   * Where the client BELIEVES its own square is, having applied its own
   * inputs without waiting for permission. Null outside a running match, when
   * there is nothing to predict and the server's word is simply followed.
   *
   * This is the only number on the client that is not a copy of something the
   * server said. It is a guess, and M6 draws it next to the truth rather than
   * instead of it.
   */
  predicted: Vector2 | null;
  /** Inputs sent but not yet acknowledged - the depth of the pending buffer. */
  pendingInputCount: number;
  /** The last input sequence number the server says it has simulated for us. */
  lastAckedInput: number;
  /** How many seats the room has, as reported by the server. */
  playersPerRoom: number;
  /** Connection status, owned by the client rather than the snapshot. */
  connection: 'connecting' | 'open' | 'closed' | 'refused';
}

const COLOURS = {
  arena: '#1b1e27',
  border: '#2c3244',
  you: '#4f8cff',
  them: '#5bd6a0',
  coin: '#f2c14e',
  coinCore: '#fff0c2',
  text: '#e6e8ee',
  textMuted: '#8b93a7',
  overlay: 'rgba(18, 20, 26, 0.84)',
  timeLow: '#ff6b6b',
  /** The server's version of where the local player is - the trailing ghost. */
  ghost: '#6b5bd6',
} as const;

function drawArena(context: CanvasRenderingContext2D): void {
  context.fillStyle = COLOURS.arena;
  context.fillRect(0, 0, ARENA_WIDTH, ARENA_HEIGHT);
  context.strokeStyle = COLOURS.border;
  context.lineWidth = 2;
  context.strokeRect(1, 1, ARENA_WIDTH - 2, ARENA_HEIGHT - 2);
}

function drawCoins(context: CanvasRenderingContext2D, coins: Coin[]): void {
  for (const coin of coins) {
    context.beginPath();
    context.arc(coin.position.x, coin.position.y, COIN_RADIUS, 0, Math.PI * 2);
    context.fillStyle = COLOURS.coin;
    context.fill();

    context.beginPath();
    context.arc(
      coin.position.x - COIN_RADIUS * 0.28,
      coin.position.y - COIN_RADIUS * 0.28,
      COIN_RADIUS * 0.32,
      0,
      Math.PI * 2,
    );
    context.fillStyle = COLOURS.coinCore;
    context.fill();
  }
}

/**
 * The server's idea of where the local player is, drawn as a hollow outline.
 *
 * This ghost is the single most useful thing on the screen in M6. The solid
 * square is the client's guess, made instantly; the outline is the truth,
 * arriving one round trip late. Watching the gap between them open when you
 * start moving and close when you stop is what "prediction" and "latency"
 * actually look like, and it turns M7 from an abstract next step into a
 * visible problem: that gap never fully closes on its own.
 *
 * Diagnostics, not gameplay. It belongs to the same family as M11's panel.
 */
function drawServerGhost(context: CanvasRenderingContext2D, at: Vector2): void {
  const halfSize = PLAYER_SIZE / 2;

  context.save();
  context.strokeStyle = COLOURS.ghost;
  context.lineWidth = 1.5;
  context.setLineDash([4, 3]);
  context.strokeRect(at.x - halfSize, at.y - halfSize, PLAYER_SIZE, PLAYER_SIZE);
  context.restore();
}

function drawPlayers(context: CanvasRenderingContext2D, view: ViewState): void {
  const halfSize = PLAYER_SIZE / 2;

  for (const player of view.players) {
    const isLocal = player.id === view.localPlayerId;
    const predicting = isLocal && view.predicted !== null;

    // The local player is drawn where we PREDICT it is; everyone else is drawn
    // where the server last said they were. A client may guess about the thing
    // it controls and nothing else - guessing at the opponent would be
    // extrapolation, which is M8's problem and needs different machinery.
    const { x, y } = predicting ? view.predicted! : player.position;

    if (predicting) drawServerGhost(context, player.position);

    context.fillStyle = isLocal ? COLOURS.you : COLOURS.them;
    context.fillRect(x - halfSize, y - halfSize, PLAYER_SIZE, PLAYER_SIZE);

    // A small label, because two coloured squares are not self-explanatory.
    context.font = '600 11px ui-monospace, Consolas, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    context.fillStyle = isLocal ? COLOURS.you : COLOURS.them;
    context.fillText(isLocal ? 'you' : `P${player.id}`, x, y - halfSize - 5);
  }
}

function formatTime(seconds: number): string {
  return `${Math.ceil(seconds)}s`;
}

function drawHud(context: CanvasRenderingContext2D, view: ViewState): void {
  context.font = '600 16px ui-monospace, "Cascadia Mono", Consolas, monospace';
  context.textBaseline = 'top';

  // Scores, local player first so the eye always finds its own number.
  const ordered = [...view.players].sort((a, b) => {
    if (a.id === view.localPlayerId) return -1;
    if (b.id === view.localPlayerId) return 1;
    return a.id - b.id;
  });

  context.textAlign = 'left';
  let x = 18;
  for (const player of ordered) {
    const isLocal = player.id === view.localPlayerId;
    const label = isLocal ? 'You' : `P${player.id}`;
    context.fillStyle = isLocal ? COLOURS.you : COLOURS.them;
    const text = `${label} ${player.score}`;
    context.fillText(text, x, 16);
    x += context.measureText(text).width + 22;
  }

  context.textAlign = 'right';
  context.fillStyle = view.timeRemaining <= 10 ? COLOURS.timeLow : COLOURS.text;
  context.fillText(formatTime(view.timeRemaining), ARENA_WIDTH - 18, 16);
}

/**
 * The three clocks, side by side.
 *
 * This readout is the entire point of M4 made visible: the world advances at
 * one rate, the client is told at a second rate, and the screen redraws at a
 * third. Seeing 30 / 10 / 60 in the corner makes "these are different clocks"
 * a fact you can watch rather than a claim.
 *
 * `tick` is the server's step counter, not a time. It climbs whether or not a
 * match is running.
 */
function drawClocks(context: CanvasRenderingContext2D, view: ViewState): void {
  context.font = '500 11px ui-monospace, "Cascadia Mono", Consolas, monospace';
  context.textAlign = 'left';
  context.textBaseline = 'bottom';
  context.fillStyle = '#4a5266';

  const parts = [
    `sim ${view.simulationHz}Hz`,
    `snap ${view.snapshotHz}Hz (${view.measuredSnapshotHz.toFixed(0)} recv)`,
    `render ${view.measuredRenderHz.toFixed(0)}Hz`,
    `tick ${view.tick}`,
  ];

  /**
   * The two M6 numbers.
   *
   * `pending` is how many inputs we have sent that the server has not yet
   * confirmed simulating - roughly one round trip's worth, so it climbs with
   * latency and is the buffer M7 replays.
   *
   * `drift` is how far our guess has wandered from the server's answer, in
   * pixels. Some of it is honest: the server is simply behind, and that part
   * shrinks to nothing when you stand still. The part that does NOT come back
   * is accumulated error from inputs the server never received, and no amount
   * of standing still fixes it. That residue is precisely what M7 exists for.
   */
  if (view.predicted !== null) {
    const authoritative = view.players.find((player) => player.id === view.localPlayerId);
    parts.push(`pending ${view.pendingInputCount}`);
    if (authoritative !== undefined) {
      const drift = Math.hypot(
        view.predicted.x - authoritative.position.x,
        view.predicted.y - authoritative.position.y,
      );
      parts.push(`drift ${drift.toFixed(0)}px`);
    }
  }

  context.fillText(parts.join('   ·   '), 18, ARENA_HEIGHT - 14);

  // The simulated network, called out separately and in a warning colour,
  // because a laggy build is easy to mistake for a broken one.
  const { latencyMs, jitterMs, lossRate } = view.network;
  if (latencyMs > 0 || jitterMs > 0 || lossRate > 0) {
    context.fillStyle = COLOURS.timeLow;
    context.textAlign = 'right';
    const net =
      `SIMULATED NET  ${latencyMs}ms` +
      (jitterMs > 0 ? ` ±${jitterMs}ms` : '') +
      (lossRate > 0 ? `  ${(lossRate * 100).toFixed(1)}% loss` : '');
    context.fillText(net, ARENA_WIDTH - 18, ARENA_HEIGHT - 14);
  }
}

/**
 * Draw the arena. Nothing else — every "the match is not running" screen is
 * the lobby's job now, which keeps this function to one responsibility and
 * makes the not-playing states focusable and clickable on a phone.
 */
export function render(context: CanvasRenderingContext2D, view: ViewState): void {
  drawArena(context);
  drawCoins(context, view.coins);
  drawPlayers(context, view);
  if (view.phase === 'playing') {
    drawHud(context, view);
    drawClocks(context, view);
  }
}
