/**
 * The simulation. No canvas, no DOM, no timers, no sockets.
 *
 * As of M3 this module has moved from `client/` to `shared/`, because it is no
 * longer the client's. The SERVER runs `update()` and owns the result; the
 * client imports this file only for the types and constants it needs in order
 * to draw what it is told.
 *
 * That move is the entire point of M3. The rule from Gambetta:
 *
 *   > Clients send inputs. The server owns the authoritative game state.
 *
 * The client never calls `update()` in M3, and as of M6 it still does not.
 * What M6 grants it is narrower and deliberately so: it may call `movePlayer`
 * on its OWN square, as a guess. It may not run `update()`, because that would
 * mean predicting coin collection and scores - guessing at a contested
 * resource that the other player might reach first, and inventing points. The
 * rule is that a client may predict what it controls and nothing else.
 *
 * M4 note: `update()` is now always called with the SAME `deltaSeconds` - one
 * fixed timestep. It still takes delta as a parameter rather than hard-coding
 * it, because M7's reconciliation replays inputs through this same function
 * and must be able to reproduce the server's arithmetic exactly.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARENA_WIDTH = 800;
export const ARENA_HEIGHT = 600;

export const PLAYER_SIZE = 26;
/** Pixels per SECOND, not per frame, not per tick. */
export const PLAYER_SPEED = 260;

export const COIN_RADIUS = 9;
export const COIN_COUNT = 6;
const COIN_SPAWN_MARGIN = 40;
const COIN_SPAWN_CLEARANCE = 90;

export const MATCH_DURATION_SECONDS = 30;

/** A room holds exactly this many players before the match starts. */
export const PLAYERS_PER_ROOM = 2;

/** Where each player starts, indexed by join order. */
const SPAWN_POINTS: readonly Vector2[] = [
  { x: 200, y: ARENA_HEIGHT / 2 },
  { x: 600, y: ARENA_HEIGHT / 2 },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlayerId = number;

export interface Vector2 {
  x: number;
  y: number;
}

export interface Player {
  id: PlayerId;
  position: Vector2;
  score: number;
  /** Has this player pressed Ready in the lobby? */
  ready: boolean;
}

export interface Coin {
  id: number;
  position: Vector2;
}

/**
 * The room's lifecycle.
 *
 *   waiting   fewer than PLAYERS_PER_ROOM players are connected
 *   lobby     everyone is here, but not everyone has pressed Ready
 *   playing   the match is running
 *   finished  the clock expired; the result stands until a rematch
 *
 * `lobby` is separate from `waiting` because "nobody to play with" and
 * "waiting on a human to press a button" are different situations and the UI
 * has to say different things about them. Starting the moment the room fills -
 * as M3 did - drops a player into a running match before they have looked at
 * the screen.
 */
export type MatchPhase = 'waiting' | 'lobby' | 'playing' | 'finished';

export interface GameState {
  phase: MatchPhase;
  players: Player[];
  coins: Coin[];
  timeRemaining: number;
  nextCoinId: number;
  /**
   * How many fixed simulation steps have been run since the server started.
   *
   * This is the server's own clock, and it is the thing that makes a snapshot
   * mean something: "here is the world" is not useful, "here is the world as
   * of step 1042" can be placed on a timeline. M7 reconciles against it and M8
   * interpolates between two of them.
   *
   * It counts steps, not seconds, and it advances even in the lobby - the
   * server is ticking whether or not anyone is playing.
   */
  tick: number;
}

/**
 * What a player is asking for — never where they ended up.
 *
 * This is now literally the payload that crosses the network. The client can
 * lie about which keys it is holding, and that is fine: the server applies the
 * same movement rules to whatever it is told, so the worst a liar achieves is
 * moving as if they pressed a key. A client that claimed a *position* could
 * teleport onto every coin in the arena.
 */
export interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export function createEmptyInput(): InputState {
  return { up: false, down: false, left: false, right: false };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Choose a spot for a coin, clear of every player.
 *
 * `Math.random()` survives into M3 for one reason: this only ever runs on the
 * server now. The trap flagged in M1 — a client inventing its own coins — is
 * closed not by seeding the generator but by moving the authority. Clients no
 * longer spawn anything; they are told.
 */
function spawnCoin(state: GameState): Coin {
  let position: Vector2 = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };

  for (let attempt = 0; attempt < 20; attempt++) {
    position = {
      x: randomBetween(COIN_SPAWN_MARGIN, ARENA_WIDTH - COIN_SPAWN_MARGIN),
      y: randomBetween(COIN_SPAWN_MARGIN, ARENA_HEIGHT - COIN_SPAWN_MARGIN),
    };

    const clearOfEveryone = state.players.every((player) => {
      const dx = position.x - player.position.x;
      const dy = position.y - player.position.y;
      return Math.hypot(dx, dy) >= COIN_SPAWN_CLEARANCE;
    });

    if (clearOfEveryone) break;
  }

  return { id: state.nextCoinId++, position };
}

export function createInitialState(): GameState {
  return {
    phase: 'waiting',
    players: [],
    coins: [],
    timeRemaining: MATCH_DURATION_SECONDS,
    nextCoinId: 1,
    tick: 0,
  };
}

export function findPlayer(state: GameState, id: PlayerId): Player | undefined {
  return state.players.find((player) => player.id === id);
}

export function addPlayer(state: GameState, id: PlayerId): Player {
  const spawn = SPAWN_POINTS[state.players.length % SPAWN_POINTS.length]!;
  const player: Player = {
    id,
    position: { x: spawn.x, y: spawn.y },
    score: 0,
    ready: false,
  };
  state.players.push(player);
  return player;
}

export function removePlayer(state: GameState, id: PlayerId): void {
  const index = state.players.findIndex((player) => player.id === id);
  if (index !== -1) state.players.splice(index, 1);
}

/** Record a player's lobby choice. Ignored outside the lobby and the result screen. */
export function setReady(state: GameState, id: PlayerId, ready: boolean): void {
  const player = findPlayer(state, id);
  if (player === undefined) return;
  if (state.phase !== 'lobby' && state.phase !== 'finished') return;
  player.ready = ready;
}

/** Everyone is present and everyone has pressed Ready. */
export function everyoneIsReady(state: GameState): boolean {
  return (
    state.players.length === PLAYERS_PER_ROOM &&
    state.players.every((player) => player.ready)
  );
}

export function clearReady(state: GameState): void {
  for (const player of state.players) player.ready = false;
}

/**
 * Move the room to the right phase after a join or a leave.
 *
 * Kept in one function so there is exactly one answer to "what phase should
 * this room be in?" - the alternative is that question being answered slightly
 * differently in the join handler and the close handler.
 */
export function refreshLobbyPhase(state: GameState): void {
  if (state.phase === 'playing') {
    // A match cannot continue one-sided. Abandon it and wait for a new opponent.
    if (state.players.length < PLAYERS_PER_ROOM) {
      state.phase = 'waiting';
      clearReady(state);
    }
    return;
  }

  if (state.players.length < PLAYERS_PER_ROOM) {
    state.phase = 'waiting';
    clearReady(state);
  } else if (state.phase === 'waiting') {
    state.phase = 'lobby';
    clearReady(state);
  }
}

/** Begin a match: fresh coins, fresh scores, full clock, ready flags cleared. */
export function startMatch(state: GameState): void {
  state.phase = 'playing';
  state.timeRemaining = MATCH_DURATION_SECONDS;
  state.coins = [];

  for (const player of state.players) {
    player.score = 0;
    // Cleared now so the result screen starts with nobody ready for a rematch.
    player.ready = false;
  }

  for (let index = 0; index < state.players.length; index++) {
    const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length]!;
    state.players[index]!.position = { x: spawn.x, y: spawn.y };
  }

  for (let i = 0; i < COIN_COUNT; i++) {
    state.coins.push(spawnCoin(state));
  }
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Circle vs axis-aligned box: clamp the coin's centre into the player's square
 * to find the closest point, then compare squared distances against the radius.
 */
function playerTouchesCoin(player: Player, coin: Coin): boolean {
  const halfSize = PLAYER_SIZE / 2;

  const closestX = clamp(
    coin.position.x,
    player.position.x - halfSize,
    player.position.x + halfSize,
  );
  const closestY = clamp(
    coin.position.y,
    player.position.y - halfSize,
    player.position.y + halfSize,
  );

  const dx = coin.position.x - closestX;
  const dy = coin.position.y - closestY;

  return dx * dx + dy * dy <= COIN_RADIUS * COIN_RADIUS;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/**
 * Apply one input to one thing with a position, for one fixed step.
 *
 * Exported as of M6, and the export is the whole point. The client now runs
 * this function to predict its own movement - not a copy of it, not a
 * close-enough reimplementation in client code, but these exact lines. The
 * client's guess and the server's answer are then produced by identical
 * arithmetic, so any disagreement between them is caused by a difference in
 * INPUTS - one of them was lost, or has not arrived yet. That is a problem M7
 * can solve. Two slightly different movement functions would produce drift
 * that nothing can solve, because there would be no single right answer to
 * reconcile towards.
 *
 * It takes `{ position }` rather than a whole `Player` because the client's
 * prediction is not a player - it has no score and no ready flag, it is just a
 * guess about where one square is.
 */
export function movePlayer(
  entity: { position: Vector2 },
  input: InputState,
  deltaSeconds: number,
): void {
  let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);

  if (dx !== 0 && dy !== 0) {
    const inverseLength = 1 / Math.SQRT2;
    dx *= inverseLength;
    dy *= inverseLength;
  }

  entity.position.x += dx * PLAYER_SPEED * deltaSeconds;
  entity.position.y += dy * PLAYER_SPEED * deltaSeconds;

  const halfSize = PLAYER_SIZE / 2;
  entity.position.x = clamp(entity.position.x, halfSize, ARENA_WIDTH - halfSize);
  entity.position.y = clamp(entity.position.y, halfSize, ARENA_HEIGHT - halfSize);
}

/**
 * Advance the world by `deltaSeconds`, applying each player's latest input.
 *
 * `inputs` is keyed by player id. A player with no input yet simply stands
 * still — which is also what happens to a player whose packets stopped
 * arriving. The simulation has no opinion about why a player is idle, and that
 * indifference is what keeps it honest under a bad network.
 *
 * Contention note: players are resolved in array order, so if both touch the
 * same coin within one tick, the earlier player wins it. That is arbitrary but
 * *deterministic* — and one machine deciding arbitrarily is exactly the point.
 */
export function update(
  state: GameState,
  inputs: ReadonlyMap<PlayerId, InputState>,
  deltaSeconds: number,
): void {
  // The tick advances first and unconditionally. It is a count of simulation
  // steps taken, not of steps that happened to do something, so a snapshot
  // from the lobby still carries a meaningful "when".
  state.tick += 1;

  if (state.phase !== 'playing') return;

  for (const player of state.players) {
    movePlayer(player, inputs.get(player.id) ?? createEmptyInput(), deltaSeconds);

    for (let i = 0; i < state.coins.length; i++) {
      if (playerTouchesCoin(player, state.coins[i]!)) {
        player.score += 1;
        state.coins[i] = spawnCoin(state);
      }
    }
  }

  state.timeRemaining -= deltaSeconds;
  if (state.timeRemaining <= 0) {
    state.timeRemaining = 0;
    state.phase = 'finished';
  }
}
