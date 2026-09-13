/**
 * The wire protocol: every message that can cross the socket, in one file both
 * sides import.
 *
 * A shared definition is what stops the client and server from drifting into
 * disagreeing about what a message means — the compiler refuses to build if
 * one side sends a shape the other does not handle. The plan's target layout
 * eventually has a `protocol.ts` on each side; sharing one is strictly better
 * while both ends are TypeScript.
 *
 * JSON for now. M12 measures whether a binary encoding is worth the loss of
 * being able to read the traffic in devtools.
 */

import type { Coin, MatchPhase, Player, PlayerId } from './game.js';

/** The default port for the game server (the M2 chat toy keeps 8080). */
export const GAME_PORT = 8081;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/**
 * The only thing a client is allowed to say.
 *
 * Note what has no message: there is no "I moved", no "I collected a coin", no
 * "my score is now 4". The protocol makes those unsayable, which is a stronger
 * guarantee than a server that merely chooses not to believe them.
 */
export interface InputMessage {
  type: 'input';
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/**
 * The lobby button. Also the only other thing a client may say.
 *
 * Note it says "I am ready", not "start the match". The client expresses a
 * preference; the SERVER decides whether that means a match begins, because
 * only the server knows whether the other player has also pressed it. Keeping
 * the decision server-side is the same rule as everywhere else - a client that
 * could say "start" could start a match alone.
 */
export interface ReadyMessage {
  type: 'ready';
  ready: boolean;
}

export type ClientMessage = InputMessage | ReadyMessage;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

/** Sent once, on connection: who you are in this room. */
export interface WelcomeMessage {
  type: 'welcome';
  playerId: PlayerId;
}

/** Sent when the room already holds PLAYERS_PER_ROOM players. */
export interface RoomFullMessage {
  type: 'room_full';
}

/**
 * The server's description of the world, as of a particular simulation step.
 *
 * This is a *full* snapshot: every player, every coin, every time. It is
 * wasteful and it is the right starting point — delta compression (M12.4) is
 * only worth doing once there is a measured bandwidth problem to point at.
 *
 * The `tick` is what M4 adds, and it changes what a snapshot *is*. Without it
 * a snapshot is "the world"; with it, a snapshot is "the world at a known
 * moment" — something that can be placed on a timeline, compared with another,
 * and interpolated between. M7 and M8 are both impossible without it.
 */
export interface SnapshotMessage {
  type: 'snapshot';
  /** The simulation step this snapshot describes. */
  tick: number;
  phase: MatchPhase;
  players: Player[];
  coins: Coin[];
  timeRemaining: number;
  /** How many players the room needs before a match can start. */
  playersPerRoom: number;
  /**
   * The two rates, reported so the client can display them.
   *
   * They are deliberately separate numbers. The simulation rate is how often
   * the world advances; the snapshot rate is how often anyone is told about
   * it. Conflating them - as M3 did - hides the fact that they answer
   * different questions and have different costs.
   */
  simulationHz: number;
  snapshotHz: number;
  /**
   * The artificial network conditions in force, so the client can display
   * them. Development tooling, reported rather than negotiated - the client
   * has no say in this and cannot switch it off.
   */
  network: {
    latencyMs: number;
    jitterMs: number;
    lossRate: number;
  };
}

export type ServerMessage = WelcomeMessage | RoomFullMessage | SnapshotMessage;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Anything arriving from the network is untrusted text until proven otherwise.
 *
 * These parsers are deliberately boring: check the shape, return `null` on
 * anything unexpected, never throw. A malformed frame from one client must not
 * be able to interrupt a match for the other.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;

  if (message['type'] === 'ready') {
    if (typeof message['ready'] !== 'boolean') return null;
    return { type: 'ready', ready: message['ready'] };
  }

  if (message['type'] !== 'input') return null;

  const flags = ['up', 'down', 'left', 'right'] as const;
  if (!flags.every((flag) => typeof message[flag] === 'boolean')) return null;

  return {
    type: 'input',
    up: message['up'] as boolean,
    down: message['down'] as boolean,
    left: message['left'] as boolean,
    right: message['right'] as boolean,
  };
}

export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null) return null;
  const message = value as Record<string, unknown>;

  switch (message['type']) {
    case 'welcome':
    case 'room_full':
    case 'snapshot':
      // The server is the one peer a client does trust, so a check on `type`
      // is enough here - the client is not defending itself from its own server.
      return message as unknown as ServerMessage;
    default:
      return null;
  }
}
