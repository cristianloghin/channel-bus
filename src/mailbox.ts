import { Channel } from "./channel";
import type { ChannelContract, Handler, Message } from "./types";
import { combineSignals, INERT_SIGNAL } from "./signals";

// ── Types ─────────────────────────────────────────────────────────────────────

// Extracts the contract type C from Channel<C>.
// Falls back to ChannelContract (rather than never) so the result always
// satisfies the ChannelContract constraint even when the inference is deferred.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContractOf<Ch> = Ch extends Channel<infer C> ? C : ChannelContract;

export type MailboxRuleClause<C extends ChannelContract> = {
  interrupts: keyof C;
  mode: "replace" | "abort" | "drop-new";
};

export type MailboxRules<C extends ChannelContract> = {
  [A in keyof C]?: Array<MailboxRuleClause<C>>;
};

// Using Channel<any> (not Channel<ChannelContract>) lets callers pass concrete
// channels like Channel<PlaybackContract> without hitting invariance errors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChannelRulesMap<Channels extends Record<string, Channel<any>>> = {
  [K in keyof Channels]?: MailboxRules<ContractOf<Channels[K]>>;
};

// ── Internal data structures ──────────────────────────────────────────────────

type QueueItem = {
  action: string;
  payload: unknown;
  message: Message<ChannelContract>;
  // undefined when the emitter provided no signal (avoids permanent listeners
  // on the module-level INERT_SIGNAL inside combineSignals).
  emitterSignal: AbortSignal | undefined;
};

type CurrentSlot = {
  controller: AbortController;
  action: string;
};

// ── ChannelContext ─────────────────────────────────────────────────────────────
//
// One context per channel key. Owns the FIFO queue, the current-slot, and the
// handler registry for that channel. Rule evaluation happens here on every
// message arrival.

class ChannelContext {
  private queue: QueueItem[] = [];
  private current: CurrentSlot | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<string, Handler<ChannelContract, any>>();
  private unsubs: Array<() => void> = [];

  constructor(
    private readonly channel: Channel<ChannelContract>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly rules: MailboxRules<any> | undefined,
  ) {}

  // Register a handler for one action and subscribe to the underlying channel.
  // Throws if a handler is already registered for the same action.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(action: string, handler: Handler<ChannelContract, any>): void {
    if (this.handlers.has(action)) {
      throw new Error(
        `[chbus] Mailbox already has a handler for action "${action}"`,
      );
    }
    this.handlers.set(action, handler);

    const unsub = this.channel.on(
      action as keyof ChannelContract,
      async (payload: unknown, meta: { message: Message<ChannelContract> }, emitterSignal: AbortSignal) => {
        this.arrive({
          action,
          payload,
          message: meta.message as Message<ChannelContract>,
          // Avoid attaching listeners to the shared INERT_SIGNAL.
          emitterSignal:
            emitterSignal === INERT_SIGNAL ? undefined : emitterSignal,
        });
      },
    );
    this.unsubs.push(unsub);
  }

  // Unsubscribe from all channel subscriptions, abort any in-flight handler,
  // and clear all state.
  destroy(): void {
    this.unsubs.forEach((u) => u());
    this.unsubs.length = 0;
    if (this.current) {
      this.current.controller.abort();
      this.current = null;
    }
    this.queue.length = 0;
    this.handlers.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  // Called synchronously from the channel subscription handler on every
  // incoming message. Applies interrupt rules, then either discards the message,
  // places it at the front of the queue, or appends it normally.
  private arrive(item: QueueItem): void {
    const clauses = this.rules?.[item.action];

    if (clauses && this.current) {
      const clause = clauses.find((r) => String(r.interrupts) === this.current!.action);
      if (clause) {
        switch (clause.mode) {
          case "drop-new":
            return; // discard — in-flight handler runs to completion

          case "replace": {
            const interruptedAction = this.current.action;
            this.current.controller.abort();
            // Remove all pending instances of the interrupted type; the new
            // arrival makes them irrelevant.
            this.queue = this.queue.filter(
              (q) => q.action !== interruptedAction,
            );
            this.queue.unshift(item);
            // drain() will be triggered when the (now-aborting) handler settles.
            return;
          }

          case "abort":
            this.current.controller.abort();
            // Discard the aborted message; place the arrival at the front.
            // Remaining pending items are unaffected.
            this.queue.unshift(item);
            return;
        }
      }
    }

    // No rule matched or nothing is currently running — standard enqueue.
    this.queue.push(item);
    void this.drain();
  }

  // Pull the next item from the queue, execute its handler, then recurse.
  // Re-entrant calls from arrive() bail out immediately if a handler is already
  // running — drain will be re-triggered after the current handler settles.
  private async drain(): Promise<void> {
    if (this.current !== null || this.queue.length === 0) return;

    const item = this.queue.shift()!;
    const controller = new AbortController();
    this.current = { controller, action: item.action };

    const handler = this.handlers.get(item.action);
    if (handler) {
      const signal = combineSignals(controller.signal, item.emitterSignal);
      try {
        await handler(item.payload, { message: item.message }, signal);
      } catch (error) {
        console.error(
          `[chbus] Mailbox handler error for action "${item.action}":`,
          error,
        );
      }
    }

    this.current = null;
    void this.drain(); // process next item
  }
}

// ── Mailbox ───────────────────────────────────────────────────────────────────

export class Mailbox<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Channels extends Record<string, Channel<any>>,
> {
  private contexts = new Map<string, ChannelContext>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(channels: Channels, rules?: ChannelRulesMap<any>) {
    for (const key of Object.keys(channels)) {
      this.contexts.set(
        key,
        new ChannelContext(
          channels[key],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rules?.[key] as MailboxRules<any> | undefined,
        ),
      );
    }
  }

  // Register a handler for one action on one channel. The handler signature
  // matches channel.on — payload, meta, signal — with signal always present.
  on<
    K extends keyof Channels & string,
    A extends keyof ContractOf<Channels[K]> & string,
  >(
    channelKey: K,
    action: A,
    handler: Handler<ContractOf<Channels[K]>, A>,
  ): void {
    const context = this.contexts.get(channelKey);
    if (!context) {
      throw new Error(
        `[chbus] Mailbox has no channel registered under key "${channelKey}"`,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context.register(action, handler as Handler<ChannelContract, any>);
  }

  // Unsubscribe all channel subscriptions and abort any in-flight handlers.
  destroy(): void {
    this.contexts.forEach((ctx) => ctx.destroy());
    this.contexts.clear();
  }
}
