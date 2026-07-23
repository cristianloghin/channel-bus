# Work Log — Improvements & Fixes

A running log of correctness fixes, API changes, and outstanding work for
`@mikrostack/chbus`, modeled on the virtual-list worklog: completed work gets
recorded here as it lands, the live backlog is below. Newest work is appended.

## Outstanding

(empty)

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
