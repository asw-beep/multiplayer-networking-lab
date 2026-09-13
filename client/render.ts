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
} from '../shared/game.js';

export interface ViewState {
  phase: MatchPhase;
  players: Player[];
  coins: Coin[];
  timeRemaining: number;
  /** Which player the local browser is controlling, once the server has said. */
  localPlayerId: PlayerId | null;
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

function drawPlayers(context: CanvasRenderingContext2D, view: ViewState): void {
  const halfSize = PLAYER_SIZE / 2;

  for (const player of view.players) {
    const isLocal = player.id === view.localPlayerId;
    const { x, y } = player.position;

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
 * Draw the arena. Nothing else — every "the match is not running" screen is
 * the lobby's job now, which keeps this function to one responsibility and
 * makes the not-playing states focusable and clickable on a phone.
 */
export function render(context: CanvasRenderingContext2D, view: ViewState): void {
  drawArena(context);
  drawCoins(context, view.coins);
  drawPlayers(context, view);
  if (view.phase === 'playing') drawHud(context, view);
}
