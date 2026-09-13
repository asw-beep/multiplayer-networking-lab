/**
 * M5 — the artificial network.
 *
 * Everything so far has run over loopback, where messages arrive in
 * microseconds, in order, and always. That is not a network; it is a function
 * call wearing a socket as a disguise. Every technique in M6-M8 exists to
 * survive conditions this project has never actually experienced.
 *
 * So before writing a single line of prediction, we make the network bad on
 * purpose and go and feel it.
 *
 *   client ──┐                                    ┌── server
 *            │  ┌──────────────────────────────┐  │
 *            └─▶│  latency  jitter  packet loss │──┘
 *               └──────────────────────────────┘
 *
 * This is development-only tooling. It degrades a connection; it never
 * improves one, and none of it ships as part of the game.
 */

/**
 * Three numbers that describe a bad connection.
 *
 * `latencyMs` is ONE WAY. A round trip - press a key, the server simulates,
 * the snapshot comes back - costs roughly twice this, which is why 100ms here
 * already feels wrong to play.
 */
export interface NetworkConditions {
  /** One-way delay applied to every message, in milliseconds. */
  latencyMs: number;
  /** Random variation added to the delay, +/- this many milliseconds. */
  jitterMs: number;
  /** Fraction of droppable messages that never arrive, 0 to 1. */
  lossRate: number;
}

export const PERFECT_NETWORK: NetworkConditions = {
  latencyMs: 0,
  jitterMs: 0,
  lossRate: 0,
};

export function isDegraded(conditions: NetworkConditions): boolean {
  return conditions.latencyMs > 0 || conditions.jitterMs > 0 || conditions.lossRate > 0;
}

export function describeConditions(conditions: NetworkConditions): string {
  if (!isDegraded(conditions)) return 'perfect (loopback)';
  return (
    `${conditions.latencyMs}ms one-way (~${conditions.latencyMs * 2}ms RTT)` +
    `, jitter ±${conditions.jitterMs}ms` +
    `, loss ${(conditions.lossRate * 100).toFixed(1)}%`
  );
}

export interface LinkStats {
  carried: number;
  delivered: number;
  dropped: number;
}

/**
 * Whether a message may be thrown away.
 *
 * Not everything is droppable, and that is a modelling decision worth
 * defending rather than a shortcut. Real games run two kinds of traffic:
 * a reliable channel for things that must arrive exactly once (you joined,
 * the room is full, the match started) and an unreliable one for the
 * high-frequency stream where a lost message is simply superseded by the next
 * one (positions, inputs).
 *
 * We are pretending our reliable WebSocket is that unreliable channel. So loss
 * applies to snapshots and inputs - the things a real game sends unreliably -
 * and never to the handshake. Dropping "welcome" would leave a client that
 * never learns its own id, which teaches nothing except that we broke it.
 */
export type Reliability = 'droppable' | 'reliable';

/**
 * One direction of one connection.
 *
 * Note what this deliberately does NOT do: reorder messages explicitly. It
 * does not have to. Jitter alone reorders them, because two messages sent a
 * millisecond apart with delays of 180ms and 120ms arrive in the opposite
 * order to the one they were sent in. That is exactly how real networks
 * reorder, and it is why the stale-snapshot guard written in M4 stops being
 * dead code the moment jitter is switched on.
 */
export function createLink<T>(
  getConditions: () => NetworkConditions,
  deliver: (payload: T) => void,
): {
  carry: (payload: T, reliability: Reliability) => void;
  stats: () => LinkStats;
  cancelAll: () => void;
} {
  const stats: LinkStats = { carried: 0, delivered: 0, dropped: 0 };

  /**
   * Messages still in flight.
   *
   * Kept so they can be cancelled when a player disconnects. Without this, a
   * snapshot scheduled 200ms ago would still try to deliver to a socket that
   * closed 100ms ago - harmless here because `send` checks readyState, but the
   * timers would keep the process alive and the leak would be real.
   */
  const inFlight = new Set<NodeJS.Timeout>();

  return {
    carry(payload: T, reliability: Reliability): void {
      const conditions = getConditions();
      stats.carried += 1;

      if (reliability === 'droppable' && Math.random() < conditions.lossRate) {
        stats.dropped += 1;
        return;
      }

      const jitter =
        conditions.jitterMs > 0 ? (Math.random() * 2 - 1) * conditions.jitterMs : 0;
      const delayMs = Math.max(0, conditions.latencyMs + jitter);

      if (delayMs === 0) {
        stats.delivered += 1;
        deliver(payload);
        return;
      }

      const timer = setTimeout(() => {
        inFlight.delete(timer);
        stats.delivered += 1;
        deliver(payload);
      }, delayMs);

      inFlight.add(timer);
    },

    stats: () => ({ ...stats }),

    cancelAll(): void {
      for (const timer of inFlight) clearTimeout(timer);
      inFlight.clear();
    },
  };
}
