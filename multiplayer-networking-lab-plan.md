# Multiplayer Networking Lab — Project Plan

## Project Goal

Build a small 2-player multiplayer game and gradually turn it into a reusable multiplayer networking framework.

The primary purpose is **learning real-time networking and distributed game architecture**, not making a visually impressive game.

The project should eventually demonstrate:

- WebSockets
- client/server architecture
- authoritative server
- fixed-timestep simulation
- game-state snapshots
- input sequence numbers
- client-side prediction
- server reconciliation
- remote-player interpolation
- artificial latency/jitter/packet-loss simulation
- reusable game architecture
- multiple games running on the same networking core
- network diagnostics
- optional advanced topics such as lag compensation, dead reckoning, binary protocols and UDP

---

# Core Design Principle

Follow this learning loop:

> Learn just enough theory → implement a small feature → deliberately break/test it → understand the problem → implement the solution.

Do NOT build the entire framework upfront.

The architecture should emerge from the problems we encounter.

Do NOT start with a generic game-engine abstraction before understanding the networking problems.

---

# Initial Game Choice

## Game 1: 2-Player Coin Collector

A simple top-down arena.

Each player controls a square/circle and collects coins.

Example:

```text
┌──────────────────────────────────────┐
│                                      │
│   Player 1              Coin         │
│      ●                               │
│                                      │
│                 Coin                 │
│                                      │
│                        Player 2      │
│                           ●          │
│                                      │
│             Coin                     │
│                                      │
└──────────────────────────────────────┘

Player 1: 3 coins
Player 2: 2 coins
Time: 42s
```

### Rules

1. Two players join the same room.
2. Players move using WASD / arrow keys.
3. Coins spawn in the arena.
4. Touching a coin collects it.
5. The authoritative server decides whether collection occurred.
6. Player score increases on collection.
7. Coins disappear and respawn.
8. Match lasts for a fixed duration.
9. Highest score wins.

Keep graphics extremely simple. Canvas shapes are sufficient.

---

# Why Coin Collector?

It is intentionally simple but provides enough game state to exercise networking:

- players
- movement
- collision
- world state
- items
- scores
- timers
- spawning
- match state

It also works well with client-side prediction and reconciliation.

Avoid adding combat, weapons, complex physics or AI until the networking foundation is working.

---

# Technology Stack

## Client

- TypeScript
- HTML Canvas
- Browser WebSocket API

## Server

- Node.js
- TypeScript
- `ws` WebSocket library

## Development

- Git
- npm
- simple local development server
- browser developer tools

Avoid React/Next.js/etc. for the game itself unless there is a later reason to introduce them.

The game should remain a simple Canvas application.

---

# High-Level Roadmap

```text
M0  Foundations
 ↓
M1  Single-player Coin Collector
 ↓
M2  WebSocket Toy
 ↓
M3  2-player authoritative multiplayer
 ↓
M4  Fixed timestep + snapshots
 ↓
M5  Artificial network problems
 ↓
M6  Client-side prediction
 ↓
M7  Server reconciliation
 ↓
M8  Remote-player interpolation
 ↓
M9  Extract reusable multiplayer architecture
 ↓
M10 Add Pong
 ↓
M11 Networking laboratory / diagnostics
 ↓
M12 Optional advanced networking
```

---

# M0 — Foundations

## Goal

Become comfortable enough with the tools that programming language/framework issues do not distract from networking concepts.

## Learn First

Learn only the following:

### TypeScript

- types
- interfaces
- classes
- functions
- modules/imports
- arrays/objects
- basic generics
- basic async/event-driven programming

Do not spend time mastering advanced TypeScript.

### Node.js

Understand:

- npm
- package.json
- scripts
- modules
- running a TypeScript/Node project
- basic event-driven programming

### HTML Canvas

Learn:

- canvas context
- drawing rectangles/circles
- clearing the canvas
- keyboard input
- `requestAnimationFrame`

## Resources

### Canvas

MDN — Drawing graphics / Canvas:

https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Client-side_APIs/Drawing_graphics

### requestAnimationFrame

https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame

## Build

Make a square that:

- renders on Canvas
- moves using WASD
- stays inside the arena

Do not add networking.

## Milestone Complete When

You can explain:

> The browser maintains game state, updates it, and renders it repeatedly using an animation loop.

---

# M1 — Build Single-Player Coin Collector

## Goal

Build the complete basic game locally before adding networking.

## Learn First

Understand:

### Game state

Example:

```ts
{
    player: {
        x: 100,
        y: 200
    },
    coins: [],
    score: 0,
    timeRemaining: 60
}
```

### Game loop

Conceptually:

```text
input
 ↓
update state
 ↓
render
 ↓
repeat
```

### Basic collision

For the first version, simple circle/rectangle distance or AABB collision is enough.

## Resource

MDN — 2D Breakout game tutorial:

https://developer.mozilla.org/en-US/docs/Games/Tutorials/2D_Breakout_game_pure_JavaScript

Use it to understand game-loop, movement and collision concepts.

Do NOT copy its architecture.

## Build

Implement:

- player movement
- arena boundaries
- 5–10 coins
- coin collision
- score
- coin respawn
- match timer
- win/end state

## Milestone Complete When

A complete single-player match can be played locally from start to finish.

---

# M2 — Learn WebSockets

## Important Rule

Pause work on the game temporarily.

Build a tiny networking experiment unrelated to the game.

## Learn First

Understand:

- persistent connection
- client
- server
- `open`
- `message`
- `close`
- `error`
- `send`
- broadcasting
- connection/disconnection handling

Mental model:

```text
HTTP:

Client ── request ──> Server
Client <── response ── Server


WebSocket:

Client <════════════> Server
       persistent
       connection
```

## Resources

### MDN WebSocket API

https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API

### MDN — Writing WebSocket client applications

https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications

## Optional Video

A beginner multiplayer/WebSocket walkthrough can be used only for conceptual understanding.

Do not blindly copy its architecture.

## Build

Create:

```text
Browser A
   │
   │ "Hello from A"
   ▼
Server
   │
   │ broadcast
   ▼
Browser B

Browser B
   │
   │ "Hello from B"
   ▼
Server
   │
   ▼
Browser A
```

Use JSON messages initially.

Example:

```json
{
  "type": "chat",
  "message": "hello"
}
```

## Milestone Complete When

Two browser tabs can communicate through the Node.js WebSocket server.

---

# M3 — Two-Player Coin Collector

## Goal

Combine the game and WebSocket knowledge.

Two browsers should be able to enter the same game and see each other.

## Learn First: Authoritative Server

Read:

### Gabriel Gambetta — Client-Server Game Architecture

https://www.gabrielgambetta.com/client-server-game-architecture.html

Understand this principle deeply:

> Clients send inputs. The server owns the authoritative game state.

### Wrong

```text
Client:
"I am at x = 500."
```

### Correct

```text
Client:
"I pressed RIGHT."

Server:
"Based on the game rules,
you are now at x = 500."
```

The client should not be trusted to determine its own authoritative position.

## Initial Protocol

Client sends input:

```json
{
  "type": "input",
  "left": false,
  "right": true,
  "up": false,
  "down": false
}
```

Server owns:

- player positions
- coins
- scores
- match timer
- game state

Server sends snapshots.

## Build

Implement:

- room with exactly 2 players
- player IDs
- connection/disconnection
- authoritative player positions
- server-controlled coins
- server-controlled scoring
- snapshots to clients

Do NOT implement prediction yet.

## Milestone Complete When

Two browser tabs can play the same Coin Collector match and see each other.

It is acceptable for movement to feel laggy.

That lag is intentional and will be useful later.

---

# M4 — Fixed Timestep + Snapshots

## Goal

Separate simulation time from network timing and rendering.

## Learn First

Understand:

> The server should run the game simulation at a controlled, predictable rate.

Example:

```text
20 server ticks/sec

Tick 1
 ↓
Tick 2
 ↓
Tick 3
 ↓
Tick 4
```

Also understand that:

```text
Rendering FPS
≠
Server simulation rate
≠
Network packet arrival rate
```

These are different clocks.

## Resources

### Gaffer On Games — Fix Your Timestep

https://gafferongames.com/post/fix_your_timestep/

### Gabriel Gambetta — Entity Interpolation

https://www.gabrielgambetta.com/entity-interpolation.html

## Build

Implement a server simulation loop.

For example:

```text
20 Hz
50 ms per tick
```

Every tick:

```text
1. collect/process inputs
2. update game simulation
3. perform collisions
4. update world
5. create snapshot
6. send snapshot
```

Snapshots should contain a server tick.

Example:

```json
{
  "type": "snapshot",
  "tick": 1042,
  "players": [],
  "coins": [],
  "scores": []
}
```

## Experiment

Try:

```text
60 Hz
30 Hz
20 Hz
10 Hz
5 Hz
```

Observe how the game changes.

## Milestone Complete When

You can explain why simulation, rendering and networking should not be treated as the same clock.

---

# M5 — Artificial Network Problems

## Goal

Experience the problems that prediction/interpolation are designed to solve.

Do this BEFORE implementing prediction.

## Learn First

Understand:

- latency
- RTT
- jitter
- packet loss
- throughput
- bandwidth

You do not need advanced networking theory yet.

## Build a Network Simulator

Conceptually:

```text
Client
   │
   ▼
┌─────────────────────┐
│ Network Simulator   │
│                     │
│ latency: 100ms      │
│ jitter: 20ms        │
│ packet loss: 5%     │
└─────────────────────┘
   │
   ▼
Server
```

Add configurable:

- latency
- jitter
- packet loss

Initially only simulate these in your development environment.

## Experiments

Try:

```text
0 ms
50 ms
100 ms
200 ms
500 ms
```

Then:

```text
Latency: 150 ms
Jitter: 30 ms
Packet loss: 5%
```

Observe:

- local movement delay
- remote player jumping
- missing snapshots
- corrections
- game responsiveness

## Milestone Complete When

You can demonstrate:

> With high latency, a purely server-authoritative client feels delayed.

This is the problem client-side prediction will solve.

---

# M6 — Client-Side Prediction

## Goal

Make the local player's movement feel responsive despite network latency.

## Learn First

Read:

### Gabriel Gambetta — Client-Side Prediction & Server Reconciliation

https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html

Focus first on client-side prediction.

Core idea:

```text
Input
 │
 ├──────────────> Server
 │
 ▼
Client predicts immediately
```

Instead of:

```text
press key
 ↓
wait for server
 ↓
receive state
 ↓
move
```

we do:

```text
press key
 ↓
move immediately locally
 ↓
send input to server
```

## Introduce Input Sequence Numbers

Example:

```text
#101 RIGHT
#102 RIGHT
#103 UP
#104 RIGHT
```

Each input gets a monotonically increasing sequence number.

## Build

Client should:

1. capture input
2. assign sequence number
3. store input in a buffer
4. apply input locally immediately
5. send input to server

Server should:

1. receive input
2. process it authoritatively
3. include the latest processed input sequence in snapshots

## Milestone Complete When

At approximately 200 ms simulated latency:

- local movement remains responsive
- server remains authoritative
- client maintains pending inputs

Do not worry about perfect reconciliation yet.

---

# M7 — Server Reconciliation

## Goal

Correct client prediction using authoritative server state.

This is one of the most important parts of the project.

## Learn First

Continue Gambetta's prediction/reconciliation article:

https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html

Understand:

```text
client predicted state
        ↓
server authoritative state
        ↓
acknowledged input sequence
        ↓
replay unacknowledged inputs
        ↓
current predicted state
```

Example:

Client has:

```text
#101
#102
#103
#104
#105
```

Server responds:

```text
authoritative position = 146
last processed input = #103
```

Client then:

```text
discard #101
discard #102
discard #103

apply #104
apply #105

result = current predicted state
```

## Build

Create clear components such as:

```text
InputBuffer
PredictionSystem
ReconciliationSystem
```

Exact names may change during implementation.

## Milestone Complete When

Under simulated latency:

- local player remains responsive
- authoritative corrections occur
- corrections do not accumulate forever
- client replays only unacknowledged inputs

---

# M8 — Remote Entity Interpolation

## Goal

Make other players appear smooth.

Prediction solves the local-player problem.

Interpolation solves the remote-player rendering problem.

## Learn First

### Gabriel Gambetta — Entity Interpolation

https://www.gabrielgambetta.com/entity-interpolation.html

### Gambetta Live Demo

https://www.gabrielgambetta.com/client-side-prediction-live-demo.html

### Gaffer On Games — Snapshot Interpolation

https://gafferongames.com/post/snapshot_interpolation/

Core idea:

Server sends snapshots:

```text
t=100 → x=100
t=200 → x=120
```

Instead of rendering:

```text
100 → 120
```

immediately, interpolate between known states.

Conceptually:

```text
100
101
102
103
...
119
120
```

## Important Concept

The local player can be rendered close to the present using prediction.

Remote players can be rendered slightly in the past using interpolation.

This gives the client enough information to create smooth motion.

## Build

Maintain enough snapshot history to interpolate remote entities.

## Milestone Complete When

At low snapshot rates and moderate latency, remote players still look reasonably smooth.

---

# M9 — Extract Reusable Multiplayer Architecture

## Important

Only do this AFTER M2–M8 work.

Do not prematurely design a generic engine.

## Goal

Separate:

```text
Multiplayer infrastructure
```

from:

```text
Game-specific logic
```

Target architecture:

```text
                 Multiplayer Core
                        │
                  Game Interface
                        │
          ┌─────────────┼─────────────┐
          │             │             │
          ▼             ▼             ▼
   Coin Collector      Pong       Future Game
```

## Multiplayer Core Owns

- WebSocket connections
- rooms
- player IDs
- connection/disconnection
- server tick
- input sequence numbers
- snapshots
- acknowledgements
- prediction protocol
- reconciliation protocol
- interpolation support
- network simulation
- network statistics

## Game Owns

For Coin Collector:

- player movement rules
- collision rules
- arena boundaries
- coin positions
- coin collection
- scoring
- coin respawning
- match timer
- win condition

## Desired Interface

Something conceptually similar to:

```ts
interface Game {
    createState(): GameState;

    addPlayer(playerId: string): void;
    removePlayer(playerId: string): void;

    handleInput(
        playerId: string,
        input: PlayerInput
    ): void;

    update(
        state: GameState,
        deltaTime: number
    ): void;

    getSnapshot(): GameSnapshot;

    isFinished(): boolean;
}
```

This is a starting idea, NOT a requirement to copy exactly.

The actual interface should be derived from the implementation experience.

## Milestone Complete When

The networking core can run Coin Collector without knowing its game-specific rules.

---

# M10 — Add Pong

## Goal

Prove that the networking architecture is actually reusable.

Add a second game:

```text
Pong
```

Keep it simple.

```text
┌─────────────────────────────┐
│ │             ●             │
│ │                           │
│ │                           │
│ │                           │
│ │                           │
│ │                     │     │
└─────────────────────────────┘
```

## Learn First

Basic:

- velocity
- collision
- reflection/bouncing
- deterministic-ish simulation

Do not introduce complex physics engines.

## Build

Create something conceptually like:

```text
games/
    coin-collector/
    pong/
```

Pong should plug into the same multiplayer infrastructure.

## Milestone Complete When

The same server can create a room running either:

```text
Coin Collector
```

or:

```text
Pong
```

without rewriting WebSocket/prediction infrastructure.

---

# M11 — Multiplayer Networking Laboratory

## Goal

Turn the project from a game into a networking experiment platform.

## Add Network Diagnostics

Example:

```text
┌─────────────────────────────┐
│ NETWORK                     │
├─────────────────────────────┤
│ RTT                 143 ms  │
│ Jitter               24 ms  │
│ Packet loss           3.2%  │
│ Server tick           20 Hz │
│ Snapshot rate         10 Hz │
│                             │
│ Prediction corrections: 17  │
│ Inputs pending:       4     │
└─────────────────────────────┘
```

## Add Controls

```text
Latency       [150 ms]
Jitter        [30 ms]
Packet Loss   [5%]
Server Tick   [20 Hz]
Snapshot Rate [10 Hz]
```

## Demonstrations

The project should be able to demonstrate:

### Without prediction

```text
200ms latency
→ local player feels delayed
```

### With prediction

```text
200ms latency
→ local player remains responsive
```

### Without interpolation

```text
low snapshot rate
→ remote player jumps
```

### With interpolation

```text
low snapshot rate
→ remote player appears smoother
```

This is an important portfolio feature.

---

# M12 — Optional Advanced Networking

Only start this after the core project is solid.

## 12.1 Lag Compensation

Resource:

https://www.gabrielgambetta.com/lag-compensation.html

Possible future game mechanic:

- shooting
- tagging
- hit detection

Explore:

- server rewind
- historical player states
- latency-aware hit validation

---

## 12.2 Dead Reckoning

Explore predicting remote player positions using:

```text
position
+
velocity
+
possibly acceleration
```

Instead of waiting for every snapshot.

---

## 12.3 Binary Protocol

Initially use JSON.

Later experiment with:

```text
JSON
 ↓
compact serialization
 ↓
binary packets
 ↓
ArrayBuffer/DataView
```

Relevant browser reference:

https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/binaryType

Measure actual bandwidth savings rather than optimizing blindly.

---

## 12.4 Snapshot Compression

Explore:

```text
full snapshot
      ↓
delta snapshot
      ↓
compressed state
```

---

## 12.5 UDP

Only after understanding WebSocket/TCP thoroughly.

Compare:

```text
WebSocket / TCP
```

with:

```text
UDP
```

Understand:

- reliability
- ordering
- congestion
- packet loss
- custom protocols

Do not rewrite the project around UDP unless there is a clear learning goal.

---

# Suggested Final Project Structure

This is the TARGET direction, not something to create on day one.

```text
multiplayer-networking-lab/
│
├── client/
│   ├── network/
│   │   ├── WebSocketClient.ts
│   │   └── protocol.ts
│   │
│   ├── prediction/
│   │   ├── InputBuffer.ts
│   │   └── Reconciliation.ts
│   │
│   ├── rendering/
│   │   └── Renderer.ts
│   │
│   └── main.ts
│
├── server/
│   ├── network/
│   │   ├── WebSocketServer.ts
│   │   └── protocol.ts
│   │
│   ├── room/
│   │   └── Room.ts
│   │
│   ├── simulation/
│   │   ├── GameLoop.ts
│   │   └── Clock.ts
│   │
│   └── main.ts
│
├── games/
│   ├── core/
│   │   ├── Game.ts
│   │   ├── GameState.ts
│   │   ├── Player.ts
│   │   └── Input.ts
│   │
│   ├── coin-collector/
│   │   ├── CoinCollector.ts
│   │   ├── State.ts
│   │   ├── Physics.ts
│   │   └── Renderer.ts
│   │
│   └── pong/
│       ├── Pong.ts
│       ├── State.ts
│       ├── Physics.ts
│       └── Renderer.ts
│
└── shared/
    ├── types.ts
    └── constants.ts
```

Do not create all these directories immediately.

---

# What NOT to Learn Yet

Avoid getting distracted by:

- Kubernetes
- Redis
- Kafka
- microservices
- WebRTC
- matchmaking at scale
- authentication
- databases
- Docker orchestration
- AWS architecture
- 3D physics
- Unity networking
- advanced UDP protocols
- AI/LLM integration

These are not prerequisites for the core project.

---

# AI/ML Ideas — Later Only

The original project idea mentions opportunities for ML/AI.

Do NOT bolt an LLM onto the project just to say it uses AI.

Once networking is genuinely working, interesting ML directions include:

## Network quality prediction

Collect:

```text
RTT
jitter
packet loss
snapshot rate
correction frequency
```

Then predict network quality and dynamically adjust:

- interpolation buffer
- snapshot rate
- update strategy

## Movement prediction

Use player movement history to predict remote movement.

Compare:

```text
simple interpolation
```

against:

```text
learned movement prediction
```

The networking problem should remain the motivation for the ML component.

---

# Core Concepts We Must Eventually Be Able to Explain

Before calling the project complete, we should be able to explain these without blindly relying on a tutorial.

## Networking

- What is latency?
- What is RTT?
- What is jitter?
- What is packet loss?
- What is bandwidth?
- What is throughput?
- TCP vs UDP?
- Why does WebSocket normally use TCP?
- What does reliable + ordered communication mean?

## Multiplayer Architecture

- What is an authoritative server?
- Why should clients send inputs rather than positions?
- What is a server tick?
- What is a fixed timestep?
- What is a snapshot?
- Why are rendering and simulation separate?

## Netcode

- What is client-side prediction?
- Why does prediction reduce perceived input latency?
- What are input sequence numbers?
- What is server reconciliation?
- Why replay unacknowledged inputs?
- What is entity interpolation?
- Why can remote entities be rendered slightly in the past?
- What is lag compensation?
- What is dead reckoning?

## Distributed Systems

Understand the fundamental problem:

> Multiple machines observe and act on state, but the server must establish a consistent authoritative state.

---

# Development Philosophy

## Rule 1 — Don't overengineer

Start with:

```text
Browser
 ↓
WebSocket
 ↓
Node.js
 ↓
Game simulation
```

Only introduce abstractions when the project needs them.

## Rule 2 — Experiment before optimizing

If something is confusing:

1. create a simple version
2. introduce bad conditions
3. observe the failure
4. learn the theory
5. implement the solution

## Rule 3 — Server is authoritative

Never weaken this principle just to make implementation easier.

## Rule 4 — Keep game logic independent

Networking code should not know that a coin exists.

## Rule 5 — Keep rendering independent

Server state should be representable without Canvas.

## Rule 6 — JSON first

Do not optimize packet size before measuring a real problem.

## Rule 7 — Git history should show the learning

Prefer focused commits such as:

```text
Create basic Canvas game
Add WebSocket connection
Implement two-player server
Implement authoritative simulation
Add fixed timestep
Add input sequence numbers
Add network latency simulation
Implement client prediction
Implement server reconciliation
Implement remote interpolation
Extract reusable game interface
Add Pong
Add network diagnostics
```

---

# Definition of Done

The project is successful when:

1. Two players can connect to the same room.
2. The server is authoritative.
3. Server simulation uses a controlled timestep.
4. Clients send numbered inputs.
5. Clients perform local prediction.
6. Server acknowledges processed inputs.
7. Clients reconcile predicted state with authoritative state.
8. Remote players are interpolated.
9. Latency/jitter/packet loss can be simulated.
10. Network statistics are visible.
11. Coin Collector works through the reusable multiplayer core.
12. Pong can be added without rewriting the networking layer.
13. The architecture and networking decisions can be explained clearly.

---

# First Session

Do ONLY this first.

## Step 1

Read:

https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Client-side_APIs/Drawing_graphics

## Step 2

Understand:

```js
function loop() {
    update();
    render();

    requestAnimationFrame(loop);
}
```

## Step 3

Create the project.

## Step 4

Render a square.

## Step 5

Add WASD movement.

## Step 6

Add one coin.

## Step 7

Detect collision.

## Step 8

Increment score.

STOP.

Do not implement WebSockets yet.

The next milestone begins only when the local Coin Collector works.

---

# Instructions for the Implementation Partner

The implementation partner should act as a senior engineer, not simply generate the entire project at once.

## General Behavior

- Follow the milestones sequentially.
- Do not implement future milestones prematurely.
- Before implementing a milestone, explain the concept that milestone is teaching.
- Identify the minimum theory/resources needed before coding.
- Ask the user to confirm when a milestone requires a conceptual understanding checkpoint.
- Prefer small, testable changes.
- Avoid unnecessary frameworks and dependencies.
- Do not introduce abstractions until they are justified by the current milestone.
- Preserve clean Git history.
- Explain important architectural decisions.
- When something breaks, help diagnose the underlying concept rather than immediately patching it.

## Critical Constraint

Do NOT build the final generic multiplayer architecture during M0–M8.

First implement the concrete Coin Collector.

Only after the networking mechanisms work should the reusable architecture be extracted in M9.

## Coding Style

Prefer:

- TypeScript
- clear types
- small modules
- simple functions
- explicit state transitions
- deterministic simulation where practical
- comments explaining networking concepts rather than obvious syntax

Avoid:

- premature optimization
- unnecessary dependencies
- complicated design patterns
- framework-heavy solutions
- magic abstractions

## Milestone Workflow

For each milestone:

```text
1. Explain the concept.
2. Give the learning resource.
3. Define the smallest implementation target.
4. Implement it.
5. Run/test it.
6. Explain what happened.
7. Perform a deliberate experiment if relevant.
8. Only then move to the next milestone.
```

## When uncertain about architecture

Prefer the simplest design that allows the current milestone to work.

Do not optimize for hypothetical future games before M9.

---

# Primary Learning Resources

## MDN

WebSockets:

https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API

WebSocket client applications:

https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications

Canvas:

https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Client-side_APIs/Drawing_graphics

requestAnimationFrame:

https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame

## Gabriel Gambetta

Client-server architecture:

https://www.gabrielgambetta.com/client-server-game-architecture.html

Client prediction + reconciliation:

https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html

Entity interpolation:

https://www.gabrielgambetta.com/entity-interpolation.html

Live demo:

https://www.gabrielgambetta.com/client-side-prediction-live-demo.html

Lag compensation:

https://www.gabrielgambetta.com/lag-compensation.html

## Gaffer On Games

Fix Your Timestep:

https://gafferongames.com/post/fix_your_timestep/

Snapshot Interpolation:

https://gafferongames.com/post/snapshot_interpolation/

Networked Physics:

https://gafferongames.com/categories/networked-physics/

---

# Immediate Next Action

Start with **M0 → M1 only**.

Do not touch multiplayer yet.

The first concrete deliverable is:

> A tiny single-player Coin Collector running in the browser with Canvas, keyboard movement, collision detection, scoring and a match timer.
