/**
 * M2 — the browser half of the WebSocket toy.
 *
 * Four events are the entire API surface worth learning here:
 *
 *   open     the connection is established and usable
 *   message  data arrived without anyone asking for it
 *   close    the connection ended, cleanly or otherwise
 *   error    something went wrong; `close` always follows
 *
 * Everything in M3 onward is built on exactly these four.
 */

const WS_URL = `ws://${location.hostname}:8080`;

const elements = {
  status: document.querySelector('#status'),
  log: document.querySelector('#log'),
  form: document.querySelector('#composer'),
  input: document.querySelector('#message'),
  send: document.querySelector('#send'),
  disconnect: document.querySelector('#disconnect'),
  reconnect: document.querySelector('#reconnect'),
  online: document.querySelector('#online'),
};

/** @type {WebSocket | null} */
let socket = null;
let myName = null;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function logLine(kind, text) {
  const line = document.createElement('div');
  line.className = `line ${kind}`;

  const time = new Date().toLocaleTimeString(undefined, { hour12: false });
  const stamp = document.createElement('span');
  stamp.className = 'stamp';
  stamp.textContent = time;

  const body = document.createElement('span');
  body.textContent = text;

  line.append(stamp, body);
  elements.log.append(line);
  elements.log.scrollTop = elements.log.scrollHeight;
  return line;
}

/**
 * `readyState` is the honest source of truth about a connection — not whether
 * you once called `connect()`. CONNECTING(0) OPEN(1) CLOSING(2) CLOSED(3).
 */
function setStatus(state) {
  elements.status.textContent = state;
  elements.status.dataset.state = state;

  const open = state === 'open';
  elements.send.disabled = !open;
  elements.input.disabled = !open;
  elements.disconnect.disabled = !open;
  elements.reconnect.disabled = open || state === 'connecting';
}

function setOnline(names) {
  elements.online.textContent = names.length
    ? `online: ${names.join(', ')}`
    : 'online: nobody';
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

function connect() {
  setStatus('connecting');
  logLine('sys', `connecting to ${WS_URL} …`);

  socket = new WebSocket(WS_URL);

  // Fires once the HTTP Upgrade handshake has completed. Anything sent before
  // this point throws — which is why the composer stays disabled until now.
  socket.addEventListener('open', () => {
    setStatus('open');
    logLine('sys', 'open — connection established');
  });

  // The whole point of the exercise: data arrives unprompted. No request was
  // made for this. The server decided to speak.
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      logLine('err', `unparseable frame: ${event.data}`);
      return;
    }
    handleMessage(message);
  });

  // A closed socket is dead for good. Reconnecting means constructing a NEW
  // WebSocket - there is no reopening the old one.
  socket.addEventListener('close', (event) => {
    setStatus('closed');
    setOnline([]);
    logLine(
      'sys',
      `close — code ${event.code}${event.reason ? ` "${event.reason}"` : ''}` +
        `${event.wasClean ? ' (clean)' : ' (unclean)'}`,
    );
    socket = null;
    myName = null;
  });

  // `error` carries no useful detail by design - exposing why a connection
  // failed would leak information about the network to page scripts. It is a
  // signal to react to, not a diagnosis; `close` always follows it.
  socket.addEventListener('error', () => {
    logLine('err', 'error — see close event for the outcome');
  });
}

function disconnect() {
  // 1000 is the "normal closure" status code. Sending a code at all is what
  // makes the close 'clean' - the peer learns this was intentional rather than
  // a dropped connection.
  socket?.close(1000, 'closed by user');
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

function handleMessage(message) {
  switch (message.type) {
    case 'welcome':
      myName = message.name;
      logLine('sys', `welcome — the server calls you "${message.name}" (id ${message.id})`);
      setOnline(message.online);
      break;

    case 'chat': {
      const mine = message.from === myName;
      logLine(mine ? 'mine' : 'them', `${message.from}: ${message.message}`);
      break;
    }

    case 'presence':
      logLine('sys', `${message.name} ${message.event === 'join' ? 'joined' : 'left'}`);
      setOnline(message.online);
      break;

    case 'error':
      logLine('err', `server: ${message.message}`);
      break;

    default:
      logLine('err', `unknown message type: ${message.type}`);
  }
}

function sendChat(text) {
  if (socket?.readyState !== WebSocket.OPEN) {
    logLine('err', 'not connected — message not sent');
    return;
  }
  // Note what is NOT done here: the message is not drawn locally. We wait for
  // the server to broadcast it back. Every client then shows the same list in
  // the order one machine decided.
  socket.send(JSON.stringify({ type: 'chat', message: text }));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = elements.input.value.trim();
  if (text === '') return;
  sendChat(text);
  elements.input.value = '';
});

elements.disconnect.addEventListener('click', disconnect);
elements.reconnect.addEventListener('click', connect);

setStatus('closed');
connect();

// Exposed deliberately so the connection can be driven from the devtools
// console - useful for poking at readyState and forcing odd close codes.
window.toy = { connect, disconnect, sendChat, socket: () => socket };
