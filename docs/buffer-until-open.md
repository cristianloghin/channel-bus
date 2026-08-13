# Feature request — buffer-until-open for command channels

**Status:** implemented, 2026-08-13. The mechanism shipped as designed below —
buffer in the channel, mailbox-owned drains, per-action claims. The normative
description now lives in [chbus-spec.md](../chbus-spec.md), Stage 3; this
document remains the design record. The items that were open when it was
written are resolved at the end.

**Raised by:** `vms-video-player`, 2026-08-13. That integration works around
the gap today; the workaround is what makes the case.

## The problem

Today's guarantee is explicit and deliberate ([chbus-spec.md](../chbus-spec.md),
"Constraints"):

> Messages arriving before a handler is registered are missed — same guarantee
> as raw channel subscriptions.

That is the right default. It keeps channels stateless and makes reasoning
local. But it has no escape hatch, and there is a class of consumer for which
"be listening first" is not achievable.

**The motivating case.** `vms-video-player`'s React hooks create the two public
channels during the first render, deliberately, so a host can subscribe and emit
immediately. The player core that *handles* commands is created one macrotask
later. Every command emitted in that window is silently dropped.

The host cannot avoid the window: it does not control when the core attaches,
and the whole point of eager channel creation is to let it act before then.

**What the workaround costs.** The consumer's visibility sync (suspend a player
when its surface leaves view, resume when it returns) cannot be written as the
obvious edge-triggered effect:

```ts
useEffect(() => {
  commands.emit(isVisible ? 'resume' : 'suspend')   // may vanish
}, [isVisible])
```

Instead it is a reconciler: it re-derives the desired state on every player
state publication and re-emits until one lands, relying on the player
republishing its full state every 250ms. That is a 104-line hook to express
two lines of intent, it only terminates because an unrelated ticker happens
to exist, and it has to be rebuilt by every consumer that hits the same
window. Its own docblock names the cause:

> Runs as a reconciler rather than firing commands on the visibility edge
> alone: the player is typically created a macrotask after mount and chbus
> does not replay, so a command emitted before the player subscribes is
> dropped. […] Player state reports re-trigger reconciliation […] so the
> desired state is enforced as soon as the player can hear it.

**A consumer-side middle ground exists, and is not enough.** The host could
gate its first command on the first `ui` state publication — proof of life,
then emit. That is a few lines, not 104. But it adds up to 250ms of latency to
the first command, it depends on an unrelated channel happening to tick, and
every consumer has to independently discover it. It is a smaller workaround,
not an absence of one.

## What the gap actually is

The motivating case is a **first-subscriber gap, not a late-subscriber gap**.
The commands lost in the startup window were never delivered to *anyone* —
there is no history to rewind, only undelivered mail. That distinction drives
the whole design:

- **Replay** means messages are delivered live *and* retained, and a late
  subscriber receives a copy of history — messages someone may already have
  handled. For commands that is re-execution of side effects, and it drags in
  addressing, acknowledgements, and cursors (a durable-inbox feature, much
  larger than this).
- **Buffer-until-open** means a message that was never delivered is held until
  someone can take it, delivered exactly once, and then gone. No history, no
  cursors, no re-execution. Once every action is open, the channel is as
  stateless as it is today.

The narrow mechanism covers the motivating case completely and refuses the
dangerous generality by construction.

## The mechanism

Three decisions shape it: the buffer lives in the channel, only mailboxes
drain it, and drains are per-action claims.

### The buffer lives in the channel — forced, not chosen

The place a message dies today is `Channel.deliver()`: no subscribers for the
action means it returns empty and the message is gone (`channel.ts`). A
mailbox is not a special citizen of the channel — its `register()` calls plain
`channel.on` and enqueues into its own FIFO (`mailbox.ts`). And in the
motivating case the mailbox *does not exist* during the window; it is created
with the player core, a macrotask late. The only party alive at emit time is
the channel.

So: a channel opted in at creation (say `{ buffered: true }`) starts with all
actions closed. Emits run the storm/loop guards and middleware exactly as
today, but the built message goes into a single per-channel buffer — in emit
order — instead of fanning out, and `emit()` resolves immediately with `[]`.
Fire-and-forget is preserved; emitters notice nothing.

### Only a mailbox drains — `channel.on` stays dumb

The drain trigger is not public `Channel` API. It is exposed to `Mailbox`
through an internal handshake, so the only party that can declare "the handler
set is complete" is a mailbox — which, in this library's own idiom, is exactly
the declaration of being a work-performer. That resolves opener ownership by
construction: an observer holding the channel *cannot* trigger the drain,
accidentally or otherwise, and `Channel`'s public surface grows nothing.

Dumb in control, not deaf: the drain routes through normal per-action
delivery, so a plain `channel.on` observer subscribed at drain time hears the
drained messages go by. That is correct — it is their first and only delivery,
and broadcast semantics are preserved.

One bonus falls out for free. Drained messages enter the mailbox through the
same `arrive()` path as live traffic, so the FIFO and the interrupt rules
apply to them. A buffer that accumulated `suspend` then `resume` during the
window does not blindly execute both — a `resume interrupts suspend, mode:
replace` rule collapses them exactly as it would live. The staleness problem
that makes buffered *commands* scary is handled by machinery that already
exists.

### Drains are per-action claims

A mailbox registers its handlers, then declares itself open:

```ts
mailbox.on('commands', 'suspend', ...)
mailbox.on('commands', 'resume', ...)
mailbox.open()   // drains suspend + resume from the buffer, in emit order
```

`open()` drains **only the actions this mailbox registered**, in their
relative emit order. This is sound because ordering in this system lives at
the mailbox boundary, not the channel log: even for live traffic there is no
cross-mailbox ordering guarantee — each mailbox context has its own FIFO and
they execute concurrently. A partial drain loses nothing live delivery ever
promised. The per-action trap (below) was fragmentation *within* one handler
set; per-mailbox fragmentation aligns the drain boundary with the ordering
boundary. The dangerous sequences — `suspend` then `resume`, `seek_time` then
`play` — are same-performer by nature, so one mailbox claims them and they
drain in log order together.

The gate is therefore **per-action, not per-channel**: an action is open once
a mailbox has claimed and drained it; live emissions to open actions pass
straight through; unclaimed actions keep buffering until claimed or aged out
by the bounds. Late subsystems compose — a playback core that opens at T1 and
a seek subsystem at T2 each take their backlog, in order, without
coordinating.

### Rules that follow

- **Drain on `open()`, never on registration.** If the drain fired when
  `suspend` was registered but `seek_time` was not yet, buffered `seek_time`
  commands would drop or wait while `suspend` went through — reordering the
  log, the exact failure this exists to prevent. Open-after-registration is
  what makes in-order drain possible. It is an API change, not just an
  addition: `Mailbox.register()` subscribes immediately today, so there is no
  moment at which the handler set is known to be complete.
- **Overlapping claims are an error.** Two mailboxes claiming the same action
  on a buffered channel is unanswerable: delivered-exactly-once collides with
  broadcast — first-open-wins silently starves the second mailbox, and
  delivering to both means the buffer cannot know when a message is consumed.
  There is also no compelling use-case: the only coherent pattern is
  multi-instance fan-out (each instance performing the command on its own
  resource), which cuts against the per-instance namespacing this library is
  actually used with; anything else is double execution of side effects. The
  spec already states the intent — "one handler per action per channel" — but
  enforces it per-mailbox only; buffered channels should enforce it for real,
  at registration time.
- **Registration after `open()` throws.** `open()` means "my handler set is
  complete"; allowing later additions would make that declaration
  meaningless.
- **`mailbox.destroy()` does not re-arm the gate.** Claimed actions stay open;
  messages emitted afterward drop exactly as on any stateless channel.
  Re-buffering on destroy would resurrect stale state — the class of thing the
  namespace teardown work (0.5.0) just eliminated.
- **Adoption prerequisite.** `vms-video-player` handles commands with plain
  `channel.on` today, mailboxes reserved for work-performing subsystems.
  Adopting this feature means moving command handling into a mailbox first.
  On its own merits that migration is right — `suspend`/`resume`/`seek_time`
  are operations with duration and interruption semantics, exactly what
  mailbox serialization and rules exist for, nothing like the
  eleven-events-per-pass UI latching that makes serialization wrong for
  observation — but the cost is real and belongs in the adoption plan.

## Why not replay

Recorded because it is the framing everyone reaches for first, including this
document's original filename.

**The per-action trap.** An MVP that offers replay as a per-action option at
subscription time —

```ts
mailbox.on('playback', 'init', handler, { replay: 'latest' })
mailbox.on('playback', 'tick', handler, { replay: 5 })
```

— fragments the log by construction. Order across actions is the semantics,
not a nicety: `suspend` then `resume` delivered backwards leaves a player
suspended forever; `seek_time` then `play` delivered backwards plays from the
wrong position. Both fail silently. Per-action retention has already discarded
the interleaving, so cross-action ordering cannot be recovered — it was never
retained.

**A bus that replays out of order is worse than one that does not replay.**
The failure is silent, intermittent, and looks like a consumer bug. Consumers
who hit it will build reconcilers again — the exact workaround this feature
exists to delete — and now on top of a mechanism that claims to have solved it.

**Replay is broadcast.** Messages carry `from`, not `to`, so retained history
would go to every late subscriber — for commands, that is re-execution of side
effects by wiretaps and second components. Buffer-until-open dissolves this
structurally: each buffered message is delivered once, at its claiming
mailbox's drain, and nothing is retained afterward for anyone else to receive.

**The latest-value need is real but already served.** State channels want
"current value per action, nothing older" — and `vms-video-player`'s `ui`
channel republishes its entire state every 250ms, so a late subscriber
converges within one tick. Cheap periodic republication is a legitimate
answer there. If latest-value retention is ever wanted on the bus, it is a
separate feature with separate semantics; it should not ride along on this
one, and this one should not be named "replay."

## Why not a channel-level `open()`

Also considered and rejected, for the record: putting `open()` on the public
`Channel` API. It would reach plain-`channel.on` consumers without a mailbox
migration, but it gives every holder of the channel the trigger — and an
observer calling `open()` prematurely drains the buffer before the real
handler set has registered. Silent, intermittent, and it looks like a consumer
bug: the exact class of failure this feature exists to remove. Mailbox-only
deletes that edge instead of guarding it with an error, keeps `Channel`'s
public surface unchanged, and bets on the same direction as the discussion
below about retiring direct subscriptions.

## Resolved at implementation (2026-08-13)

- **Bounds.** `{ maxMessages: 100, maxAgeMs: 10_000 }` by default, overridable
  per channel via `buffer: { … }`. Eviction is lazy (push, drain, size reads),
  oldest-first, one `[chbus]` warning per dropped message. An unclaimed
  action degrades to today's behavior: its messages age out.
- **What drained handlers see.** As proposed: original id, timestamp, sender
  and coordination chain preserved; middleware, guards, and the debug wiretap
  not re-run; `deferred: true` marks the delivered copy; the delivery carries
  an inert signal and the mailbox combines its own as usual.
- **The handshake.** Three symbol-keyed methods on `Channel` (`claimAction`,
  `openActions`, `releaseClaims`), imported by `mailbox.ts`, never exported
  from `index.ts`, no-ops on unbuffered channels. Naming settled as
  `{ buffer: true }` and `open()`.
- **Interaction with `destroy()`.** The buffer clears with the channel, and
  the no-resurrection property across `NamespacedBus.destroy()` + recreation
  is asserted in `bus.test.ts`.
- **Mailboxes spanning multiple channels.** Each channel context claims and
  opens independently; stated in the spec (Stage 3) rather than left to
  inference.
- **One more rule that emerged during implementation:** claims are taken in
  `register()` *before* any other state is touched, so a cross-mailbox
  collision throws with nothing half-registered; and `destroy()` releases
  only never-opened claims, so an opened action stays held by its (dead)
  owner rather than silently becoming grabbable.

## Related: retiring direct channel subscriptions

Under discussion separately, and this design leans into it: making the mailbox
the only party that can drain is a bet on mailboxes as the way work gets
handled. Worth recording one consumer's experience all the same: mailboxes
serialize execution and apply interrupt rules, which is right for
work-performing subsystems and wrong for pure observation.
`vms-video-player`'s UI bindings subscribe to eleven events per publication
pass and only latch values; serializing that adds queueing to a hot path for
no benefit. If everything becomes a mailbox, observation may want to stay a
distinct, cheaper mode within it.

## What the consumer will do meanwhile

Nothing. `vms-video-player` and its UI package ship in lockstep with one
in-house consumer, so a private command queue built now would only have to be
deleted later. The visibility-sync reconciler stays until this lands. Adopting
it then means two moves in that repo: migrate command handling from plain
`channel.on` into a mailbox, and delete the reconciler.
