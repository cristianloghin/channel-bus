# @mikrostack/chbus

A typed, channel-based event bus for TypeScript. Organise messaging into named, strongly-typed channels with middleware pipelines, loop detection, storm control, and full observability. The **Mailbox** layer adds per-participant serial execution and priority interrupt rules on top of plain channels — making it the preferred way to receive messages in most applications.

## When to use chbus

If you need a **lightweight typed event emitter** and nothing else, [mitt](https://github.com/developit/mitt) or [nanoevents](https://github.com/ai/nanoevents) are simpler choices. If you need **push-based reactive streams** with composable operators, reach for [RxJS](https://rxjs.dev).

chbus is the right fit when you need more than a basic emitter but less than a full reactive system — specifically when your application has subsystems that must **process messages serially**, respond differently to **competing messages** (replace, abort, or drop), and benefit from built-in loop detection, storm control, and observability without the overhead of setting all that up manually.

---

## Installation

```bash
npm install @mikrostack/chbus
```

---

## Quick start

```ts
import { createBus } from '@mikrostack/chbus'

type PlaybackContract = {
  'playback:start': { trackId: string }
  'playback:stop':  { trackId: string }
}

const bus = createBus()
const playback = bus.channel<PlaybackContract>('playback')

// Preferred: receive messages through a Mailbox
const mailbox = bus.createMailbox({ playback })

mailbox.on('playback', 'playback:start', async (payload, meta, signal) => {
  console.log('starting', payload.trackId)
})

playback.emit('playback:start', { trackId: 'track-1' }, { from: 'playerService' })

// Teardown
mailbox.destroy()
bus.destroy()
```

---

## Core concepts

### Bus

The `Bus` is the single entry point. It owns all channels and the internal debug wiretap. Create one with the `createBus()` factory:

```ts
const bus = createBus()

// With global storm config:
const bus = createBus({ storm: { maxMessages: 50, windowMs: 500 } })
```

### Channel contract

A **contract** is a plain TypeScript type that maps action names to their payload types. You define contracts — the library imposes no schema.

```ts
type UIContract = {
  'ui:status-update': { label: string }
  'ui:modal-open':    { id: string }
  'ui:modal-close':   void
}
```

### Channel

A channel is a strongly-typed message conduit scoped to one contract. Retrieve (or create) a channel by name:

```ts
const ui = bus.channel<UIContract>('ui')
```

Calling `bus.channel('ui')` more than once returns the same instance — channels are singletons within a bus. The name `'debug'` is reserved and will throw.

---

## Mailbox

A **Mailbox** is the recommended way to receive messages. It sits between channels and your handler code and provides:

- **Serial execution** — one handler at a time per channel; the next message waits until the current one finishes.
- **Interrupt rules** — declare what happens when a higher-priority message arrives while another is running.
- **Signal management** — every handler receives an `AbortSignal` that is automatically aborted when an interrupt rule fires. Emitter signals propagate through transparently.

Channels remain plain observable wires. All delivery policy lives in the mailbox.

### Creating a mailbox

```ts
const mailbox = bus.createMailbox(
  {
    videoControl: playback,   // Channel<PlaybackContract>
    camera: cameraChannel,    // Channel<CameraContract>
  },
  // Rules are optional — omit entirely for a plain serial queue
  {
    videoControl: {
      seek: [
        { interrupts: 'tick', mode: 'abort' },
      ],
      tick: [
        { interrupts: 'tick', mode: 'replace' },
      ],
    },
    // camera omitted — no rules, plain serial queue
  },
)
```

Pass any number of channel keys in the first argument. Rule declarations are optional per channel, and the rules argument itself is optional.

### Registering handlers

```ts
// Handler signature: payload, meta, signal — same as channel.on
mailbox.on('videoControl', 'seek', async (payload, meta, signal) => {
  await handleSeek(payload, signal)
})

mailbox.on('videoControl', 'tick', async (payload, meta, signal) => {
  await handleTick(payload, signal)
})

mailbox.on('camera', 'camera-select', async (payload, meta, signal) => {
  await handleCameraSelect(payload, signal)
})
```

One handler per action per channel. Registering a second handler for the same action throws immediately.

### Interrupt modes

Rules are keyed by the **arriving** action and specify which running action they interrupt and how.

#### `replace`

Aborts the running handler. Clears all pending instances of the interrupted type from the queue. Places the new arrival at the front.

Use when only the latest instance of a message type is meaningful — the arrival makes all in-flight and queued work of that type irrelevant.

```
tick arrives, tick is running, two more ticks are queued
→ abort running tick, remove both queued ticks
→ queue: [tick(new)]
```

```ts
// Only the latest tick ever matters
tick: [{ interrupts: 'tick', mode: 'replace' }]
```

#### `abort`

Aborts the running handler and discards it. Places the new arrival at the front. Other pending messages are not touched.

Use when the arrival should interrupt current work but the remaining queue should stay intact. The interrupted message is not re-queued — if fresh instances will arrive naturally there is no need to preserve the old one.

```
seek arrives, tick is running, buffer-update is pending
→ abort tick, discard it
→ queue: [seek, buffer-update]
```

```ts
// A seek interrupts any running tick but leaves other pending work alone
seek: [{ interrupts: 'tick', mode: 'abort' }]
```

#### `drop-new`

Discards the arriving message. The running handler completes undisturbed.

Use when in-flight work must finish before the same type runs again — a guard against duplicate initialisations.

```
init arrives, init is running
→ incoming init is dropped
→ queue: [init(running)]
```

```ts
// Ignore duplicate inits while one is already running
init: [{ interrupts: 'init', mode: 'drop-new' }]
```

### Self-rules

A rule where the arriving type and the interrupted type are the same governs what happens when a message arrives while the same type is already executing. All three modes apply:

| Pattern | Mode | Meaning |
|---|---|---|
| `tick: [{ interrupts: 'tick', mode: 'replace' }]` | `replace` | Only the latest tick ever runs |
| `init: [{ interrupts: 'init', mode: 'drop-new' }]` | `drop-new` | Run once, ignore duplicates |
| `seek: [{ interrupts: 'seek', mode: 'abort' }]` | `abort` | Stop current seek, start new one |

### Signal handling

Every handler receives a pre-composed `AbortSignal` as its third argument. The signal is always present — handlers never need to null-check it.

When an interrupt rule fires and aborts a running handler, the handler's signal is aborted. Handlers are responsible for checking `signal.aborted` at async boundaries and propagating the signal to downstream calls. The mailbox does not force-terminate a handler — one that ignores the signal runs to completion, and the next message will not dequeue until it does.

```ts
mailbox.on('videoControl', 'seek', async (payload, meta, signal) => {
  for (const chunk of payload.chunks) {
    if (signal.aborted) return   // bail early when interrupted
    await processChunk(chunk, signal)
  }
})
```

The signal is a combination of two sources via `combineSignals`:
- **Mailbox signal** — aborted when an interrupt rule fires.
- **Emitter signal** — if the original `channel.emit` call included a `signal` in its options, it is propagated here. If the emitter provided no signal, this source is silent.

```ts
// Emitter signal propagates through the mailbox to the handler
const controller = new AbortController()
playback.emit('seek', { position: 30 }, { signal: controller.signal })

// The handler's signal will abort when either source aborts
```

### Teardown

```ts
mailbox.destroy()
```

Unsubscribes from all channels and aborts any in-flight handler's signal immediately. The mailbox cannot be reused after `destroy()`.

### Type inference

Channel keys and action names are fully inferred from the channel instances passed as the first argument. No manual type annotation is needed anywhere.

```ts
// TypeScript error — 'unknown-action' is not a key of PlaybackContract
mailbox.on('videoControl', 'unknown-action', handler)

// TypeScript error — payload.position does not exist on tick's payload type
mailbox.on('videoControl', 'tick', async ({ position }) => { ... })
```

---

## Channel — direct use

For simple notification or broadcast patterns where serial execution and interrupts are not needed, you can subscribe directly to a channel with `channel.on()`.

### Subscribing — `on()`

```ts
const unsub = playback.on('playback:start', async (payload, meta, signal) => {
  console.log(meta.message.from, payload.trackId)
})

// Later:
unsub()
```

Handler signature:

```ts
async (payload, meta, signal) => void
```

- `payload` — the message payload, typed from the channel contract.
- `meta.message` — the full `Message` object: `id`, `namespace`, `channel`, `action`, `from`, `coordinationChain`, `timestamp`.
- `signal` — an `AbortSignal`. Always present. If the emitter provided a signal in `EmitOptions`, this is that signal. If none was provided, this is a no-op signal that never aborts. Handlers never need to null-check it.

Pass `{ signal }` in options to automatically unsubscribe when an `AbortSignal` fires:

```ts
const controller = new AbortController()

playback.on('playback:start', handler, { signal: controller.signal })

// Unsubscribes automatically when the signal aborts:
controller.abort()
```

> **Note:** When multiple subscribers are registered for the same action on a plain channel, they all receive every message concurrently via `Promise.allSettled`. If you need serial execution or priority rules, use a [Mailbox](#mailbox) instead.

### Emitting — `emit()`

`emit()` is always async — it returns `Promise<SettledResult[]>` and fans out to all subscribers registered with `on()` using `Promise.allSettled`.

**The caller decides whether to await:**

```ts
// Fire-and-forget — the promise is intentionally not awaited
playback.emit('playback:start', { trackId: 'track-1' })

// Fire-and-forget with an abort signal
const ac = new AbortController()
playback.emit('playback:start', { trackId: 'track-1' }, { signal: ac.signal })

// Awaitable — wait for all handlers to settle
const results = await playback.emit('playback:start', { trackId: 'track-1' }, { from: 'player' })

results.forEach((r) => {
  if (r.status === 'rejected') console.error('handler failed:', r.reason)
})
```

A failing subscriber never prevents others from running — `allSettled` guarantees full fan-out. `emit()` returns `[]` when no subscribers are registered, when the message is dropped by a guard, or when the signal was already aborted at call time.

#### Emit signal

Pass a `signal` in `EmitOptions` to allow the emitter to cancel delivery:

```ts
const controller = new AbortController()

playback.emit('seek', { position: 1200 }, { signal: controller.signal })

// If aborted before any subscriber runs — all subscribers are skipped, resolves []
// If aborted mid-fan-out — unstarted subscribers are skipped; running ones receive
//   the signal and are responsible for checking it at their own async boundaries
controller.abort()
```

---

## Middleware

Middleware runs in insertion order before subscribers are notified. Each middleware receives the full typed `Message` and a `next` function. If `next()` is not called the message is silently dropped.

```ts
playback.use((message, next) => {
  console.log(`[${message.channel}] ${String(message.action)}`)
  next()
})

// Conditional gating:
playback.use((message, next) => {
  if (isAuthorised(message.from)) next()
  // else: message is dropped silently
})
```

Middleware is chainable:

```ts
channel
  .use(loggingMiddleware)
  .use(authMiddleware)
  .use(metricsMiddleware)
```

---

## Namespaced bus

When a third-party library integrates with chbus, it should receive a `NamespacedBus` rather than the root `Bus`. A `NamespacedBus` scopes all channel creation to a single namespace and deliberately does not expose `onDebug()` or `namespace()`.

```ts
import { NamespacedBus } from '@mikrostack/chbus'

// Library declares what it needs:
export function createVideoPlayer(bus: NamespacedBus) {
  const playback = bus.channel<PlaybackContract>('playback')
  // Channels are registered as 'player:playback' on the root bus.
}

// Application wires them together:
const bus = createBus()
createVideoPlayer(bus.namespace('player'))
```

Channels from different namespaces are fully isolated even when they share an action name.

```ts
const ns1 = bus.namespace('player')
const ns2 = bus.namespace('analytics')

ns1.channel<UIContract>('ui')   // registered as 'player:ui'
ns2.channel<UIContract>('ui')   // registered as 'analytics:ui' — distinct instance
```

Multiple calls to `bus.namespace('player')` return independent proxy objects but write to the same underlying channel registry — `ns1.channel('playback')` and `ns2.channel('playback')` (same namespace) return the same `Channel` instance.

---

## Loop detection

When multiple channels are wired together it is easy to create event cycles (A emits → B reacts → A emits → …). chbus automatically detects and drops looping messages using a coordination chain appended to every emitted message.

Pass the incoming chain through `EmitOptions` when reacting to a message:

```ts
playback.on('playback:start', async (payload, { message }) => {
  ui.emit(
    'ui:status-update',
    { label: `Playing ${payload.trackId}` },
    {
      from: 'playbackService',
      coordinationChain: [...message.coordinationChain],
      // chbus appends its own coordination ID before forwarding.
      // If it recognises any existing ID as its own, the message is dropped.
    },
  )
})
```

When a loop is detected a warning is logged to the console and the message is dropped:

```
[chbus] Loop detected on channel "player:ui" action "ui:status-update" from "playbackService"
```

Each channel retains up to 10,000 coordination IDs, evicting the oldest when the limit is reached.

---

## Storm control

Each channel tracks message rates per sender within a sliding window. If a sender exceeds the threshold, subsequent messages are dropped with a warning:

```
[chbus] Storm detected on channel "player:playback" from sender "trackService" — 101 messages in 1000ms
```

**Global config** (applies to all channels):

```ts
const bus = createBus({
  storm: { maxMessages: 100, windowMs: 1000 }, // these are the defaults
})
```

**Per-channel override:**

```ts
// High-frequency channel — raise the limit
const telemetry = bus.channel<TelemetryContract>('telemetry', {
  storm: { maxMessages: 1000, windowMs: 1000 },
})
```

---

## Debug wiretap

Every message that completes the emit flow is automatically forwarded to the debug wiretap — emitters and subscribers are completely unaware of it. It is only accessible on the root `Bus`.

```ts
const unsubDebug = bus.onDebug((msg) => {
  console.debug(
    `[${msg.qualifiedChannel}] ${msg.action}`,
    { from: msg.from, payload: msg.payload },
  )
})

// Stop listening:
unsubDebug()
```

`DebugMessage` shape:

```ts
{
  namespace:         'player',
  channel:           'playback',
  qualifiedChannel:  'player:playback',   // 'playback' if no namespace
  action:            'playback:start',
  payload:           { trackId: 'track-1' },
  from:              'playerService',
  coordinationChain: ['abc123'],
  timestamp:         1711234567890,
  messageId:         'xyz789',
}
```

---

## Console logger

`createLogger` is a zero-config devtool built on the debug wiretap. It pretty-prints every message using `console.groupCollapsed` and returns a stop function.

```ts
import { createLogger } from '@mikrostack/chbus'

const stop = createLogger(bus)

// Later, in cleanup:
stop()
```

**Options:**

```ts
const stop = createLogger(bus, {
  collapsed: false,               // use console.group instead of console.groupCollapsed
  filter: {
    namespaces: ['player'],       // only log messages from the 'player' namespace
    channels:   ['playback'],     // only log messages from the 'playback' channel
    actions:    ['playback:start'],
  },
})
```

All filter arrays are optional and independent — combine them to narrow output to exactly the traffic you care about.

---

## Lifecycle

Channels and the bus expose a `destroy()` method that clears all subscribers, cancels pending timers, and releases internal state. Calling `emit()` on a destroyed channel is a no-op and logs a warning.

```ts
// Destroy a single channel:
playback.destroy()

// Destroy the bus and all its channels:
bus.destroy()
```

Always call `mailbox.destroy()` before `bus.destroy()` to ensure in-flight handlers are signalled and channel subscriptions are cleaned up properly.

```ts
mailbox.destroy()
bus.destroy()
```

---

## API reference

### `createBus(config?: BusConfig): Bus`

| Option | Type | Default | Description |
|---|---|---|---|
| `storm.maxMessages` | `number` | `100` | Max messages per sender per window |
| `storm.windowMs` | `number` | `1000` | Window duration in milliseconds |

---

### `Bus`

| Method | Returns | Description |
|---|---|---|
| `channel<C>(name, options?)` | `Channel<C>` | Get or create a channel. Throws for `'debug'`. |
| `namespace(name)` | `NamespacedBus` | Create a namespaced proxy for library integration. |
| `createMailbox(channels, rules?)` | `Mailbox<Channels>` | Create a mailbox over one or more channels. |
| `onDebug(handler)` | `() => void` | Subscribe to the debug wiretap. Returns unsubscribe. |
| `destroy()` | `void` | Destroy all channels and clear internal state. |

---

### `Mailbox<Channels>`

Created via `bus.createMailbox()`.

| Method | Returns | Description |
|---|---|---|
| `on(channelKey, action, handler)` | `void` | Register a handler. Throws if a handler is already registered for this action. |
| `destroy()` | `void` | Unsubscribe all channels and abort any in-flight handler. |

**Handler signature:**

```ts
async (payload: C[A], meta: { message: Message<C, A> }, signal: AbortSignal) => void
```

**Rules shape:**

```ts
type MailboxRules<C> = {
  [action in keyof C]?: Array<{
    interrupts: keyof C
    mode: 'replace' | 'abort' | 'drop-new'
  }>
}
```

---

### `NamespacedBus`

| Property / Method | Returns | Description |
|---|---|---|
| `namespace` | `string` | The namespace this proxy is scoped to. |
| `channel<C>(name, options?)` | `Channel<C>` | Get or create a namespaced channel. |

---

### `Channel<C>`

| Property / Method | Returns | Description |
|---|---|---|
| `name` | `string` | Unqualified channel name. |
| `namespace` | `string` | Namespace, or `''` if none. |
| `use(middleware)` | `this` | Append middleware to the pipeline. |
| `on(action, handler, options?)` | `() => void` | Register an async handler. Returns unsubscribe. |
| `emit(action, payload, options?)` | `Promise<SettledResult[]>` | Fan-out to all handlers. Awaitable or fire-and-forget. |
| `destroy()` | `void` | Clear all handlers, timers, and state. |

---

### `EmitOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `from` | `string` | `'anonymous'` | Sender identity |
| `coordinationChain` | `string[]` | `[]` | Upstream chain for loop detection |
| `signal` | `AbortSignal` | — | Abort delivery before or during fan-out |

---

### `SettledResult`

| Field | Type | Description |
|---|---|---|
| `status` | `'fulfilled' \| 'rejected'` | Outcome of the handler |
| `reason` | `unknown` | Rejection reason, present only when `status` is `'rejected'` |

---

### `LoggerOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `collapsed` | `boolean` | `true` | Use `groupCollapsed` instead of `group` |
| `filter.namespaces` | `string[]` | — | Only log messages from these namespaces |
| `filter.channels` | `string[]` | — | Only log messages from these channel names |
| `filter.actions` | `string[]` | — | Only log messages matching these action names |
| `filter.exclude.namespaces` | `string[]` | — | Block messages from these namespaces |
| `filter.exclude.channels` | `string[]` | — | Block messages from these channel names |
| `filter.exclude.actions` | `string[]` | — | Block messages matching these action names |
| `filter.predicate` | `(action, payload, meta) => boolean` | — | Custom filter function |

---

### `combineSignals`

Combines any number of `AbortSignal` values (or `undefined`) into a single signal that aborts as soon as any source aborts.

```ts
import { combineSignals } from '@mikrostack/chbus'

const combined = combineSignals(signalA, signalB, undefined)
// combined aborts when either signalA or signalB aborts
```

Accepts `undefined` for any argument — missing sources are ignored. Used internally by the Mailbox to combine the interrupt signal with the emitter signal before invoking a handler.

---

## TypeScript

The library is written in strict TypeScript and ships with full `.d.ts` declarations. Payload types are inferred directly from your contract — no casting needed anywhere in the public API.

```ts
// Payload is inferred as { trackId: string }
playback.on('playback:start', async (payload) => {
  payload.trackId  // ✓ string
  payload.unknown  // ✗ TypeScript error
})
```

Mailbox types are also fully inferred from the channels passed to `createMailbox` — action names and payload shapes are constrained to the correct contract per channel key.

```ts
// Both the action name and the handler payload are typed from PlaybackContract
mailbox.on('videoControl', 'seek', async ({ position }) => {
  // position: number  ✓
})
```

Use `NamespacedBus` in library type signatures to communicate intent — it signals that the library will only create channels, not subscribe to the wiretap or spawn new namespaces:

```ts
import type { NamespacedBus } from '@mikrostack/chbus'

export interface VideoPlayerOptions {
  bus: NamespacedBus
}
```
