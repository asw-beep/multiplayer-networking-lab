/**
 * The lobby screen.
 *
 * Everything that is not the match itself lives here: connecting, waiting for
 * an opponent, readying up, and the result. It is DOM rather than canvas
 * drawing, because these are buttons and text — things the browser is already
 * good at, and things that need to be focusable and clickable on a phone.
 *
 * It owns no game state. It reads a snapshot-derived view and emits one
 * intention: "the player toggled ready". The server decides what that means.
 */

import { MATCH_DURATION_SECONDS, type PlayerId } from '../shared/game.js';
import type { ViewState } from './render.js';

export interface LobbyCallbacks {
  onToggleReady: (ready: boolean) => void;
}

interface LobbyElements {
  root: HTMLElement;
  heading: HTMLElement;
  detail: HTMLElement;
  slots: HTMLElement;
  readyButton: HTMLButtonElement;
  hint: HTMLElement;
}

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing element: ${selector}`);
  return element;
}

export function createLobby(callbacks: LobbyCallbacks): (view: ViewState) => void {
  const elements: LobbyElements = {
    root: must('#lobby'),
    heading: must('#lobby-heading'),
    detail: must('#lobby-detail'),
    slots: must('#lobby-slots'),
    readyButton: must<HTMLButtonElement>('#lobby-ready'),
    hint: must('#lobby-hint'),
  };

  /**
   * What this client last asked for, which is not necessarily what the server
   * has agreed to. The button reflects the SERVER's opinion of our ready flag
   * (it arrives in every snapshot); this is only used to decide what the next
   * click should ask for.
   */
  let requestedReady = false;

  elements.readyButton.addEventListener('click', () => {
    requestedReady = !requestedReady;
    callbacks.onToggleReady(requestedReady);
  });

  function renderSlots(view: ViewState, capacity: number): void {
    elements.slots.replaceChildren();

    for (let index = 0; index < capacity; index++) {
      const player = view.players[index];
      const slot = document.createElement('div');
      slot.className = 'slot';

      const name = document.createElement('span');
      name.className = 'slot-name';

      const status = document.createElement('span');
      status.className = 'slot-status';

      if (player === undefined) {
        slot.classList.add('empty');
        name.textContent = 'Empty seat';
        status.textContent = 'waiting';
      } else {
        const isLocal = player.id === view.localPlayerId;
        slot.classList.add(isLocal ? 'local' : 'remote');
        name.textContent = isLocal ? `You (P${player.id})` : `Player ${player.id}`;

        if (view.phase === 'finished') {
          status.textContent = `${player.score} ${player.score === 1 ? 'coin' : 'coins'}`;
          status.classList.add('score');
        } else if (player.ready) {
          status.textContent = 'ready';
          status.classList.add('ready');
        } else {
          status.textContent = 'not ready';
        }
      }

      slot.append(name, status);
      elements.slots.append(slot);
    }
  }

  function describeResult(view: ViewState): string {
    const me = view.players.find((player) => player.id === view.localPlayerId);
    const them = view.players.find((player) => player.id !== view.localPlayerId);
    if (me === undefined || them === undefined) return 'Match over';
    if (me.score > them.score) return `You win, ${me.score}–${them.score}`;
    if (me.score < them.score) return `You lose, ${me.score}–${them.score}`;
    return `Draw, ${me.score} each`;
  }

  return function updateLobby(view: ViewState): void {
    // During a match the lobby gets out of the way entirely.
    const hidden = view.connection === 'open' && view.phase === 'playing';
    elements.root.hidden = hidden;
    if (hidden) return;

    const localPlayer = view.players.find(
      (player) => player.id === (view.localPlayerId as PlayerId),
    );

    // The server's opinion wins. If it says we are not ready — because the
    // match ended, or an opponent left and flags were cleared — the button
    // must agree, or the next click would ask for the wrong thing.
    if (localPlayer !== undefined) requestedReady = localPlayer.ready;

    let canReady = false;

    switch (view.connection) {
      case 'connecting':
        elements.heading.textContent = 'Connecting…';
        elements.detail.textContent = 'Reaching the game server.';
        elements.hint.textContent = 'If this hangs, the server may not be running: npm run game';
        break;

      case 'closed':
        elements.heading.textContent = 'Disconnected';
        elements.detail.textContent = 'The connection to the server was lost.';
        elements.hint.textContent = 'Reload the page to rejoin.';
        break;

      case 'refused':
        elements.heading.textContent = 'Room is full';
        elements.detail.textContent = 'This match already has two players.';
        elements.hint.textContent = 'Wait for a seat to open, then reload.';
        break;

      case 'open':
        switch (view.phase) {
          case 'waiting':
            elements.heading.textContent = 'Waiting for an opponent';
            elements.detail.textContent =
              'The match needs two players. Share the address on the other device.';
            elements.hint.textContent = 'Ready unlocks once both seats are filled.';
            break;

          case 'lobby':
            elements.heading.textContent = 'Ready up';
            elements.detail.textContent = `Both players must press Ready. The match runs for ${MATCH_DURATION_SECONDS} seconds.`;
            elements.hint.textContent = 'Move with WASD or the arrow keys. Collect the most coins.';
            canReady = true;
            break;

          case 'finished':
            elements.heading.textContent = describeResult(view);
            elements.detail.textContent = 'Press Ready for a rematch.';
            elements.hint.textContent = 'Scores reset when the next match starts.';
            canReady = true;
            break;

          case 'playing':
            break;
        }
        break;
    }

    renderSlots(view, view.playersPerRoom);

    elements.readyButton.disabled = !canReady;
    elements.readyButton.textContent = requestedReady ? 'Ready ✓ — waiting' : 'Ready';
    elements.readyButton.classList.toggle('is-ready', requestedReady);
  };
}
