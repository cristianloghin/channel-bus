# Work Log — Improvements & Fixes

A running log of correctness fixes, API changes, and outstanding work for
`@mikrostack/chbus`, modeled on the virtual-list worklog: completed work gets
recorded here as it lands, the live backlog is below. Newest work is appended.

## Outstanding

Nothing at the moment.

## Completed

### 2026-07-23 — `channel()` throws on conflicting options for an existing channel

Previously `Bus.getOrCreate` ([`bus.ts`](../src/bus.ts)) returned the existing
channel and ignored the caller's `ChannelOptions` entirely — whichever party
touched a channel name first won its config, decided by call ordering invisible
to both parties. Found in the wild (2026-07-23, first `vms-video-player` host
integration): the player creates `video_ui` with `storm: { maxMessages: 1000 }`
inside a deferred React effect, so a host that merely *accessed* the channel
earlier pinned the default 100-message storm guard onto a channel that
republishes the full player state on every clock tick — silent throttling, no
error.

`channel()` remains get-or-create, but a config conflict is now loud:

- `Channel` retains its resolved `StormConfig` as a public readonly field.
- On the existing-channel branch, `getOrCreate` resolves the caller's options
  against the bus-level config and throws if the result differs from the live
  channel's config, naming both configs in the error.
- Optionless access always succeeds (pure access), and options that *resolve
  to the same config* as the existing channel also succeed, so idempotent
  re-creation stays legal. Only an access expressing a conflicting config
  opinion throws.
- The check lives in `getOrCreate`, so root and namespaced paths are both
  covered.

Note for consumers: a previously silent situation is now a runtime throw, so
this warrants a minor-version bump.

Considered and rejected, for the record:

- *Split `createChannel` (owns config, throws if exists) from `channel`
  (access-only)* — cleaner ownership semantics, but a breaking API change
  for marginal gain over the loud error.
- *Most-permissive-wins merging* (e.g. max `maxMessages`) — defensible for
  the storm guard specifically (it is a debugging aid, not a boundary), but
  it makes the effective config emergent and order-independent in a way
  that is hard to reason about later.
- *`console.warn` instead of throw* — a warning scrolling past in a busy
  console would have let the `vms-video-player` integration ship with the
  same silent throttling.

Downstream: `vms-video-player` also plans to return its typed channels from
the React hooks so hosts never access channels by name at all (see that
repo's `docs/tech-debt.md`, "From the first host integration") — that
removes the common path into this trap; the guard here protects every other
multi-party case.

### 2026-08-13 — Buffer-until-open for command channels

Implements the feature designed in
[buffer-until-open.md](./buffer-until-open.md) (raised the same day as
"replay", reframed to deferred delivery before any code was written). A
channel opted in at creation (`{ buffer: true }`, or partial
`{ maxMessages, maxAgeMs }` over defaults 100 / 10 s) starts with every
action closed: emits run the guards, middleware, and the debug forward as
always, then divert into a per-channel buffer in emit order. Mailboxes own
the drain — `mailbox.on()` claims the action (a cross-mailbox claim throws
at registration, before any state is touched), `mailbox.open()` declares
the handler set complete and drains each claimed action's backlog through
the normal queue, so interrupt rules coalesce stale contradictory commands
for free. The gate is per action: late subsystems with disjoint actions
each collect their own backlog on their own `open()`. Drained deliveries
preserve the original message identity and carry `deferred: true`.

Decisions of record:

- The buffer is its own class (`MessageBuffer`, mirroring the guard idiom)
  living in `Channel`; the trigger is mailbox-only via symbol-keyed internal
  methods on `Channel` (`claimAction` / `openActions` / `releaseClaims`)
  that no-op on unbuffered channels and are not exported from the package.
- `open()` is a seal: registering after it throws, opening twice throws —
  uniform across buffered and unbuffered channels. A mailbox that never
  calls `open()` behaves exactly as before this change.
- `destroy()` before open releases claims (another mailbox can take over
  the intact buffer); after open the actions stay held and the gate stays
  open — destroy never re-arms anything.
- Accepted edge, documented in the spec: a handler that synchronously emits
  into the same channel mid-drain can interleave ahead of later drained
  items; async emits cannot.

154 tests green, including the motivating scenario — commands emitted
before the mailbox exists execute in emit order on `open()` — and the
no-resurrection assertion across namespace teardown. New public API
(`ChannelOptions.buffer`, `Mailbox.open()`, `Message.deferred`) with no
breaking changes — warrants a minor-version bump.

Downstream: `vms-video-player` adopts by moving command handling from plain
`channel.on` into a mailbox, then deleting its visibility-sync reconciler.

### 2026-08-13 — Release all claims on mailbox destroy

Revises one buffer-until-open decision from the entry above, found while
writing the adoption guide for `vms-video-player` (the first consumer).
`destroy()` originally kept an opened action's claim held by its dead owner
— "enforce one handler per action for real." The consumer showed the cost:
a host that replaces one player core with another on the same namespace
*without disposing it* gets the memoised channels back, and the dead core's
retained claims make the successor's registration throw. Sequential
replacement is a legitimate lifecycle; claims exist to prevent double
execution among mailboxes that are *alive*, and a dead mailbox has no claim
to defend.

`destroy()` now releases every claim the mailbox held. Nothing else moves:
the gate never re-arms (opened actions stay open, nothing re-buffers), a
pre-open destroy still hands a successor the intact buffer, and live
mailboxes still conflict at registration. One-line change in
`MessageBuffer.release()`; the "destroy after open keeps the action held"
test flipped to assert the successor takes over live traffic.

Shipped after 0.6.0 was published — goes out as a patch release.
