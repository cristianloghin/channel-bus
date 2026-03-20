# @mikrostack/chbus

A typed, channel-based event bus for TypeScript. Organise messaging into named, strongly-typed channels with middleware pipelines, loop detection, storm control, and dual sync/async delivery tracks. A built-in debug wiretap and console logger give full observability with zero coupling to your application code.

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

playback.on('playback:start', (payload) => {
  console.log('starting', payload.trackId)
})

playback.emit('playback:start', { trackId: 'track-1' }, { from: 'playerService' })
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

ns1.channel<UIContract>('ui')        // registered as 'player:ui'
ns2.channel<UIContract>('ui')        // registered as 'analytics:ui' — distinct instance
```

Multiple calls to `bus.namespace('player')` return independent proxy objects but write to the same underlying channel registry — `ns1.channel('playback')` and `ns2.channel('playback')` (same namespace) return the same `Channel` instance.

---

## Subscribing

### Sync subscribers — `on()`

Registered with `on()` and called by `emit()`. Must be synchronous (any returned value is ignored).

```ts
const unsubscribe = playback.on('playback:start', (payload, { message }) => {
  console.log(message.from, payload.trackId)
})

// Later:
unsubscribe()
```

### Async subscribers — `onAsync()`

Registered with `onAsync()` and called by `emitAsync()`. Must return a `Promise<void>`.

```ts
const unsubscribe = buffer.onAsync('buffer:flush', async (payload) => {
  await writeToDisk(payload.data)
})
```

The two tracks are completely separate — `on()` subscribers are never called by `emitAsync()`, and `onAsync()` subscribers are never called by `emit()`.

The `message` in meta gives you full context: `id`, `namespace`, `channel`, `action`, `from`, `coordinationChain`, `timestamp`.

---

## Emitting

### Sync — `emit()`

Fire-and-forget. Delivers only to subscribers registered with `on()`. Returns immediately; no async work is awaited.

```ts
playback.emit('playback:start', { trackId: 'track-1' })

// With sender identity:
playback.emit('playback:start', { trackId: 'track-1' }, { from: 'playerService' })
```

### Async — `emitAsync()`

Delivers only to subscribers registered with `onAsync()`. Awaits all of them in parallel using `Promise.allSettled` and returns their outcomes as `SettledResult[]`.

```ts
buffer.onAsync('buffer:flush', async (payload) => {
  await writeToDisk(payload.data)
})

const results = await buffer.emitAsync('buffer:flush', { data: pendingFrames })

results.forEach((r) => {
  if (r.status === 'rejected') console.error('subscriber failed:', r.reason)
})
```

Because `allSettled` is used, a failing subscriber never prevents others from running. `emitAsync` returns `[]` if no async subscribers are registered or if the message is dropped.

### Choosing an emit method

| | `emit` | `emitAsync` |
|---|---|---|
| Subscriber track | `on()` | `onAsync()` |
| Awaitable | No | Yes — `Promise<SettledResult[]>` |
| Isolation | Sync only | Async only |
| Use when | Notifications, broadcasts | Critical side-effects must complete before proceeding |

---

## Middleware

Middleware runs in insertion order before subscribers are notified. It applies to **both** `emit()` and `emitAsync()`. Each middleware receives the full typed `Message` and a `next` function. If `next()` is not called the message is silently dropped.

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

## Loop detection

When multiple channels are wired together it is easy to create event cycles (A emits → B reacts → A emits → …). chbus automatically detects and drops looping messages using a coordination chain appended to every emitted message.

Pass the incoming chain through `EmitOptions` when reacting to a message:

```ts
playback.on('playback:start', (payload, { message }) => {
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
  collapsed: false,            // use console.group instead of console.groupCollapsed
  filter: {
    namespaces: ['player'],       // only log messages from the 'player' namespace
    channels:   ['playback'],  // only log messages from the 'playback' channel
    actions:    ['playback:start'],
  },
})
```

All filter arrays are optional and independent — combine them to narrow output to exactly the traffic you care about.

---

## Lifecycle

Channels and the bus expose a `destroy()` method that clears all subscribers, cancels pending timers, and releases internal state. Calling `emit()` or `emitAsync()` on a destroyed channel is a no-op and logs a warning.

```ts
// Destroy a single channel:
playback.destroy()

// Destroy the bus and all its channels:
bus.destroy()
```

---

## API reference

### `createBus(config?: BusConfig): Bus`

| Option | Type | Default | Description |
|---|---|---|---|
| `storm.maxMessages` | `number` | `100` | Max messages per sender per window |
| `storm.windowMs` | `number` | `1000` | Window duration in milliseconds |

### `Bus`

| Method | Returns | Description |
|---|---|---|
| `channel<C>(name, options?)` | `Channel<C>` | Get or create a channel. Throws for `'debug'`. |
| `namespace(name)` | `NamespacedBus` | Create a namespaced proxy for library integration. |
| `onDebug(handler)` | `() => void` | Subscribe to the debug wiretap. Returns unsubscribe. |
| `destroy()` | `void` | Destroy all channels and clear internal state. |

### `NamespacedBus`

| Property / Method | Returns | Description |
|---|---|---|
| `namespace` | `string` | The namespace this proxy is scoped to. |
| `channel<C>(name, options?)` | `Channel<C>` | Get or create a namespaced channel. |

### `Channel<C>`

| Property / Method | Returns | Description |
|---|---|---|
| `name` | `string` | Unqualified channel name. |
| `namespace` | `string` | Namespace, or `''` if none. |
| `use(middleware)` | `this` | Append middleware to the pipeline. |
| `on(action, subscriber)` | `() => void` | Register a sync subscriber. Returns unsubscribe. |
| `onAsync(action, subscriber)` | `() => void` | Register an async subscriber. Returns unsubscribe. |
| `emit(action, payload, options?)` | `void` | Sync fire-and-forget. Delivers to `on()` subscribers only. |
| `emitAsync(action, payload, options?)` | `Promise<SettledResult[]>` | Async fan-out. Delivers to `onAsync()` subscribers only. |
| `destroy()` | `void` | Clear all subscribers, timers, and state. |

### `ChannelOptions`

| Field | Type | Description |
|---|---|---|
| `storm` | `Partial<StormConfig>` | Per-channel storm config override. Merged with global config. |

### `EmitOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `from` | `string` | `'anonymous'` | Sender identity |
| `coordinationChain` | `string[]` | `[]` | Upstream chain for loop detection |

### `SettledResult`

| Field | Type | Description |
|---|---|---|
| `status` | `'fulfilled' \| 'rejected'` | Outcome of the async subscriber |
| `reason` | `unknown` | Rejection reason, present only when `status` is `'rejected'` |

### `LoggerOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `collapsed` | `boolean` | `true` | Use `groupCollapsed` instead of `group` |
| `filter.namespaces` | `string[]` | — | Only log messages from these namespaces |
| `filter.channels` | `string[]` | — | Only log messages from these channel names |
| `filter.actions` | `string[]` | — | Only log messages matching these action names |

---

## TypeScript

The library is written in strict TypeScript and ships with full `.d.ts` declarations. Payload types are inferred directly from your contract — no casting needed anywhere in the public API.

```ts
// Payload is inferred as { trackId: string }
playback.on('playback:start', (payload) => {
  payload.trackId  // ✓ string
  payload.unknown   // ✗ TypeScript error
})
```

Use `NamespacedBus` in library type signatures to communicate intent — it signals that the library will only create channels, not subscribe to the wiretap or spawn new namespaces:

```ts
import type { NamespacedBus } from '@mikrostack/chbus'

export interface VideoPlayerOptions {
  bus: NamespacedBus
}
```
