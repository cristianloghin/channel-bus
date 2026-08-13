# Work Log — Improvements & Fixes

A running log of correctness fixes, API changes, and outstanding work for
`@mikrostack/chbus`, modeled on the virtual-list worklog: completed work gets
recorded here as it lands, the live backlog is below. Newest work is appended.

## Outstanding

- **Buffer-until-open for command channels** — see
  [buffer-until-open.md](./buffer-until-open.md) (formerly `replay.md`).
  Raised by the `vms-video-player` integration, where the React hooks create
  channels a macrotask before the core that handles commands exists, so
  everything emitted in that window is dropped and the consumer carries a
  104-line reconciler to work around it. Reframed 2026-08-13: the startup
  window is a first-subscriber gap — undelivered mail, not history to rewind —
  so the note now proposes deferred delivery rather than replay, which stays
  in the doc as the rejected framing (per-action opt-in fragments the log;
  broadcast replay re-executes side effects). A design discussion the same
  day settled the shape: the channel owns the buffer (it is the only party
  alive at emit time), only mailboxes can trigger a drain (`channel.on` stays
  dumb), and each mailbox drains just the actions it registered — sound
  because ordering was only ever guaranteed per mailbox, and it lets late
  subsystems each collect their own backlog without coordinating. Drained
  messages flow through the normal mailbox queue, so interrupt rules coalesce
  stale contradictory commands for free. Not implemented; still open are
  bounds, the channel↔mailbox handshake, and drained-message metadata.
  Adoption requires `vms-video-player` to move command handling from plain
  `channel.on` into a mailbox first — argued in the doc to be correct on its
  own merits.

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
