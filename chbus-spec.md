# `@mikrostack/chbus` — Implementation Spec

Three staged changes. Each stage must be complete and green before the next
begins.

---

# Stage 1 — Unify async API

## Goal

Remove the sync/async split. `on` and `emit` become the only subscription and
emission methods. Both are async. The `onAsync` and `emitAsync` methods are
deleted.

## Current behaviour (to be replaced)

- `on(action, handler)` — sync handler, called by `emit()`
- `onAsync(action, handler)` — async handler, called by `emitAsync()`
- `emit(action, payload, options?)` — fire-and-forget, void
- `emitAsync(action, payload, options?)` — async fan-out, returns `Promise<SettledResult[]>`

## New behaviour

### `on(action, handler)`

Handler signature:

```typescript
async (payload, meta, signal) => void
```

- `payload` — the message payload, typed from the channel contract
- `meta` — the message metadata (`id`, `namespace`, `channel`, `action`, `from`,
  `coordinationChain`, `timestamp`) — same shape as today
- `signal` — an `AbortSignal`. Always present. If the emitter provided a signal
  via `EmitOptions`, this is that signal. If none was provided, this is a
  no-op signal that never aborts. Handlers never need to null-check it.

### `emit(action, payload, options?)`

Returns `Promise<SettledResult[]>`. Fan-out using `Promise.allSettled`.

`EmitOptions` gains an optional `signal` field:

```typescript
interface EmitOptions {
  from?: string
  coordinationChain?: string[]
  signal?: AbortSignal
}
```

If a signal is provided and is already aborted when `emit` is called, all
subscribers are skipped and `emit` resolves with an empty array. If the signal
aborts mid-fan-out, any subscribers not yet called are skipped. Subscribers
already running are not force-terminated — they receive the signal and are
responsible for bailing at their own async boundaries.

The caller decides whether to await:

```typescript
// Fire-and-forget
channel.emit('seek', { position: 1200 })

// Fire-and-forget with abort signal
const ac = new AbortController()
channel.emit('seek', { position: 1200 }, { signal: ac.signal })

// Awaitable
await channel.emit('seek', { position: 1200 }, { from: 'player' })
```

## What changes

- `Channel.on` — accepts async handlers only. Handler gains `signal` as third
  argument. Drop the sync handler path.
- `Channel.emit` — returns `Promise<SettledResult[]>` instead of `void`.
  `EmitOptions` gains optional `signal` field.
- `Channel.onAsync` — deleted.
- `Channel.emitAsync` — deleted.
- All internal delivery logic consolidates onto one path.
- Middleware documentation updated — applies to `emit` only (no longer "both
  emit and emitAsync").
- `SettledResult` type is unchanged.

## TDD approach

1. Update existing `on`/`emit` tests to expect async behaviour — tests go red.
2. Update existing `onAsync`/`emitAsync` tests to use `on`/`emit` — tests go red.
3. Implement the unified async path — tests go green.
4. Delete `onAsync`/`emitAsync` and their tests.
5. Full suite must be green before proceeding to Stage 2.

---

# Stage 2 — Mailbox

## Overview

A `Mailbox` is a per-participant message handling layer that sits between bus
channels and the handler methods of a class or subsystem. It subscribes to one
or more channels on behalf of its owner, serialises message execution
per-channel, and applies interrupt rules when higher-priority messages arrive.

Channels remain dumb observable wires. All delivery policy lives in the
mailbox.

## API

```typescript
const mailbox = bus.createMailbox(
  {
    videoControl: playback,   // Channel<PlaybackContract>
    camera: cameraChannel,    // Channel<CameraContract>
  },
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
  }
)

// Handler signature matches channel.on — payload, meta, signal
// signal here is owned by the mailbox, not the emitter
mailbox.on('videoControl', 'seek', async (payload, meta, signal) => {
  await handleSeek(payload, signal)
})

mailbox.on('videoControl', 'tick', async (payload, meta, signal) => {
  await handleTick(payload, signal)
})

mailbox.on('camera', 'camera-select', async (payload, meta, signal) => {
  await handleCameraSelect(payload, signal)
})

// Teardown — unsubscribes all channels, aborts any in-flight handler
mailbox.destroy()
```

## Handler signature

The mailbox `on` callback has the same signature as `channel.on`:

```typescript
async (payload, meta, signal) => void
```

- `payload` — typed from the channel contract
- `meta` — message metadata, same shape as the channel meta
- `signal` — a combined signal composed from the mailbox-owned interrupt signal
  and the emitter-provided signal (if any). Always present, never null.

The mailbox combines both signals before invoking the handler using
`combineSignals(mailboxSignal, emitterSignal)`. The handler receives one signal
and does not need to know which source triggered the abort. If no emitter signal
was provided, the combined signal is effectively just the mailbox signal.

## Rules shape

Rules are declared per channel, keyed by the **arriving** message type. Each
entry is an array of interrupt clauses — one per message type it can interrupt.
In practice most entries will have a single clause.

```typescript
type MailboxRules<C> = {
  [K in keyof C]?: Array<{
    interrupts: keyof C
    mode: 'replace' | 'abort' | 'drop-new'
  }>
}
```

Actions with no special behaviour are omitted. A channel with no rules at all
is omitted from the rules argument. The rules argument itself is optional — a
mailbox with no rules is a plain serial queue for all its channels.

## Interrupt modes

### `replace`

Aborts the currently executing handler via `AbortSignal`. Clears all pending
instances of the interrupted type from the queue. Places the arriving message
at the front of the queue.

Use when the arriving message makes any in-flight or pending work of the
interrupted type irrelevant.

```
tick arrives, tick is running
→ abort running tick, clear any pending ticks
→ queue: [tick(new)]
```

### `abort`

Aborts the currently executing handler via `AbortSignal` and discards it.
Places the arriving message at the front of the queue. Pending queue is
unaffected.

Use when the arriving message should interrupt current work but leave other
pending messages intact. The interrupted message is not re-queued — if new
instances are expected naturally (e.g. from a time update event), there is no
need to preserve the aborted one.

```
seek arrives, tick is running, buffer-update is pending
→ abort tick, discard it
→ queue: [seek, buffer-update]
```

### `drop-new`

Discards the arriving message if the interrupted type is currently executing.
The in-flight handler runs to completion undisturbed.

Use when in-flight work must complete before the same type can run again.

```
init arrives, init is running
→ incoming init is dropped
→ queue: [init(running)]
```

## Self-rules

A rule where the arriving type and the interrupted type are the same governs
what happens when a message arrives while the same type is already executing.
All three modes apply. Common cases:

- `replace` — only the latest instance matters (tick, seek)
- `drop-new` — run once, ignore duplicates (init, save)
- `abort` — stop current, enqueue new normally

## Rule evaluation

When a message arrives:

1. Look up the arriving action type in the rules table.
2. If a matching clause exists for the currently executing message type, apply
   the mode.
3. For `replace` only — also scan the pending queue and remove all instances of
   the interrupted type.
4. If no clause matches, enqueue normally.

Clauses are evaluated in declaration order. First match wins.

## Type inference

Channel keys and action names are fully inferred from the channel instances
passed as the first argument. No manual type annotation is required.

- Keys of the first argument constrain the keys of the rules object and the
  first argument of `mailbox.on`.
- Action names in rules and `mailbox.on` are constrained to `keyof Contract`
  for the respective channel.

## AbortSignal contract

Every handler receives an `AbortSignal` as its third argument regardless of
whether it participates in any rule. This is unconditional — it keeps handler
signatures consistent and allows rules to be added later without touching
handler code.

The signal is always a combination of the mailbox-owned interrupt signal and
the emitter-provided signal via `combineSignals(mailboxSignal, emitterSignal)`.
`combineSignals` accepts `undefined` for either argument. If neither source
ever aborts, the signal remains inert for the lifetime of the handler.

Handlers are responsible for checking `signal.aborted` at async boundaries and
propagating the signal to downstream async calls. The mailbox does not
force-terminate a handler — a handler that ignores the signal runs to
completion, and the next message will not dequeue until it does.

## Constraints

- Rules are scoped to a single channel. Cross-channel interruption is not
  supported.
- One handler per action per channel. Registering a second handler for the same
  action on the same channel is an error.
- Messages arriving before a handler is registered are missed — same guarantee
  as raw channel subscriptions. (Stage 3 adds buffered channels as the
  opt-in exception.)
- `createMailbox` lives on `Bus`, not on `Channel`.

## What the mailbox does not do

- Reorder messages outside of interrupt rule application
- Merge or coalesce messages
- Add retry logic
- Inspect message payload content
- Affect other mailboxes subscribed to the same channel

## TDD approach

1. Write tests covering: channel context isolation, serial execution, all three
   interrupt modes, self-rules, missing rules (plain enqueue), abort signal
   threading, type inference, and `destroy`. Tests go red.
2. Implement `createMailbox` on `Bus`. Tests go green.
3. Full suite must be green before shipping.

## Implementation notes for Claude Code

The data structure per channel context is:

- A standard FIFO queue (array) for pending messages
- A single current slot holding the executing message and its `AbortController`
- The rules table as a flat object keyed by arriving action type, evaluated on
  each arrival

There is no heap, no priority scoring, and no continuous re-ordering. Priority
is expressed entirely through point-in-time rule evaluation when a message
arrives. Keep the implementation as close to this description as possible —
the simplicity is intentional.

---

# Stage 3 — Buffered channels (buffer-until-open)

## Goal

Give command channels an escape hatch from the "be listening first"
constraint without giving up statelessness anywhere else. Deferred delivery,
not replay: a message is held only while it has never been delivered, is
delivered exactly once, and is then gone. Design rationale and the rejected
alternatives (general replay, a public channel-level `open()`) are recorded
in [docs/buffer-until-open.md](./docs/buffer-until-open.md).

## Behaviour

- `ChannelOptions.buffer` opts a channel in at creation: `true` for defaults,
  or partial `{ maxMessages, maxAgeMs }` merged over them (100 / 10 000 ms).
  Buffered-ness and bounds are part of channel identity — a later access
  expressing a conflicting config throws, exactly like storm config.
- On a buffered channel every action starts **closed**. `emit()` runs the
  storm and loop guards, middleware, and the debug forward exactly as on any
  channel, then diverts the built message into a single per-channel buffer
  (emit order) instead of delivering, and resolves `[]`. A middleware drop
  never reaches the buffer. Zero subscribers is fine — buffering with nobody
  attached is the point.
- **Mailboxes own the drain.** `Mailbox.on()` on a buffered channel claims
  the action for that mailbox before touching any other state; a claim held
  by another mailbox throws at registration time. `Mailbox.open()` declares
  the handler set complete: each claimed action is marked open and its
  backlog delivered synchronously, in emit order, through the channel's
  normal delivery path — drained messages enter the mailbox queue and are
  subject to interrupt rules exactly like live traffic.
- The gate is **per action**, not per channel. Unclaimed actions keep
  buffering until claimed or aged out; opened actions pass live emissions
  straight through, permanently. Two mailboxes with disjoint action sets
  each drain their own backlog on their own `open()`.
- Drained deliveries preserve the original `id`, `timestamp`, `from`, and
  `coordinationChain`, and carry `deferred: true`. Middleware, the guards,
  and the debug wiretap are not re-run — all were paid at emit time. The
  emitter's signal is expired by drain time; the delivery carries an inert
  signal and the mailbox combines its own as usual.
- Plain `channel.on` subscribers cannot claim or open. Any that are attached
  when a drain runs receive the drained messages — their first and only
  delivery. Broadcast is preserved; replay does not exist.
- Bounds evict lazily (on push, on drain, on size reads): oldest-first over
  `maxMessages`, expiry over `maxAgeMs`, one `[chbus]` warning per dropped
  message.

## Lifecycle rules

- Registering on a mailbox after `open()` throws — `open()` means the
  handler set is complete. This rule is uniform across buffered and
  unbuffered channels.
- A second `open()` on the same mailbox throws.
- `mailbox.destroy()` releases every claim the mailbox held, opened or not.
  Claims police *concurrent* mailboxes; a dead one must not block its
  successor (sequential core replacement on a reused namespace is a
  legitimate lifecycle — found by the first consumer). Before open, the
  buffer is intact and a successor takes over the backlog; after open, the
  gate stays open — destroy never re-arms it — and a successor simply
  handles live traffic.
- `channel.destroy()` clears the buffer. Namespace teardown therefore cannot
  resurrect buffered messages — recreation yields fresh channels (asserted
  in tests).

## Constraints amendments

- Stage 2's "messages arriving before a handler is registered are missed"
  holds for unbuffered channels and for opened actions; buffered channels
  are the deliberate, opt-in exception.
- Stage 2's "one handler per action per channel" is enforced *across
  mailboxes* on buffered channels via claims. On unbuffered channels it
  remains per-mailbox, as before.

## Known accepted edge

The drain loop is synchronous, so drained messages enter mailbox queues
atomically with respect to live emits. One exception: the first drained
message's handler starts inside the loop (the mailbox dequeues immediately),
so a handler that *synchronously* emits back into the same channel during a
drain can interleave its new message between drained items. Async emits
cannot. Guarding this would require two-phase delivery machinery for an
already-pathological pattern; it is documented instead.

## Implementation notes

The buffer is its own class (`MessageBuffer`, `src/buffer.ts`), mirroring the
guard idiom: queue, per-action open set, per-action claim map keyed by
claimant object identity. The channel↔mailbox handshake is three
symbol-keyed methods on `Channel` (`claimAction`, `openActions`,
`releaseClaims`) — imported by `mailbox.ts`, never exported from `index.ts`,
and no-ops on unbuffered channels, which is the entire buffered/unbuffered
branch on the mailbox side.
