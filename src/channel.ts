import { LoopGuard } from "./loop";
import { StormGuard } from "./storm";
import type {
  ChannelContract,
  DebugMessage,
  EmitOptions,
  Handler,
  Message,
  Middleware,
  Next,
  SettledResult,
  StormConfig,
} from "./types";

// A signal that never aborts — used when the emitter provides no signal.
const _noop = new AbortController();
const NOOP_SIGNAL = _noop.signal;

export class Channel<C extends ChannelContract> {
  readonly name: string; // unqualified channel name
  readonly namespace: string; // '' if created directly on the root Bus

  private middlewares: Middleware<C>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private subscribers = new Map<keyof C, Set<Handler<C, any>>>();
  private stormGuard: StormGuard;
  private loopGuard = new LoopGuard();
  private destroyed = false;

  // Injected by the Bus at construction time — forwards every emitted message
  // to the debug wiretap. The channel itself is unaware of the debug channel.
  private readonly onEmit: (msg: DebugMessage) => void;

  constructor(
    name: string,
    namespace: string,
    stormConfig: StormConfig,
    onEmit: (msg: DebugMessage) => void,
  ) {
    this.name = name;
    this.namespace = namespace;
    // Pass the qualified name so storm warnings include full context.
    const qualifiedName = namespace ? `${namespace}:${name}` : name;
    this.stormGuard = new StormGuard(qualifiedName, stormConfig);
    this.onEmit = onEmit;
  }

  // ── Middleware ──────────────────────────────────────────────────────────────

  // Appends to the middleware pipeline. Runs for every emit().
  // Middleware runs in insertion order and must call next() to continue.
  use(middleware: Middleware<C>): this {
    this.middlewares.push(middleware);
    return this;
  }

  // ── Subscription ────────────────────────────────────────────────────────────

  // Register an async handler. Returns an unsubscribe function.
  // Pass { signal } to automatically unsubscribe when the signal is aborted.
  on<A extends keyof C>(
    action: A,
    handler: Handler<C, A>,
    options?: { signal?: AbortSignal },
  ): () => void {
    if (options?.signal?.aborted) return () => {};
    const unsub = this.addSubscriber(this.subscribers, action, handler);
    options?.signal?.addEventListener("abort", unsub, { once: true });
    return unsub;
  }

  // ── Emission ─────────────────────────────────────────────────────────────────

  // Async fan-out. Returns a Promise that resolves when all handlers have settled.
  // Uses Promise.allSettled — a rejecting handler does not prevent others from
  // running. Returns [] if the message is dropped, the signal is already aborted,
  // or no handlers are registered. The caller decides whether to await.
  async emit<A extends keyof C>(
    action: A,
    payload: C[A],
    options?: EmitOptions,
  ): Promise<SettledResult[]> {
    if (this.destroyed) {
      console.warn(`[chbus] emit() called on destroyed channel "${this.name}"`);
      return [];
    }

    const signal = options?.signal ?? NOOP_SIGNAL;
    if (signal.aborted) return [];

    const message = this.buildMessage(action, payload, options);
    if (!message) return [];

    // Since runMiddleware is synchronous, deliveryPromise will be set (or
    // remain null) before runMiddleware returns. A null value means middleware
    // dropped the message — resolve immediately with empty results.
    let deliveryPromise: Promise<SettledResult[]> | null = null;

    this.runMiddleware(message, () => {
      this.forwardDebug(message);
      deliveryPromise = this.deliver(action, payload, message, signal);
    });

    return deliveryPromise ?? [];
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  destroy(): void {
    this.destroyed = true;
    this.stormGuard.destroy();
    this.loopGuard.destroy();
    this.subscribers.clear();
    this.middlewares.length = 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  // Validates storm and loop constraints, builds and returns the Message.
  // Returns null if the message should be dropped.
  private buildMessage<A extends keyof C>(
    action: A,
    payload: C[A],
    options?: EmitOptions,
  ): Message<C, A> | null {
    const from = options?.from ?? "anonymous";
    const incomingChain = options?.coordinationChain ?? [];
    const id = crypto.randomUUID();

    // Storm check — drop if sender is flooding this channel.
    if (!this.stormGuard.check(from)) return null;

    // Loop check — drop if this action's ID is already in the chain.
    if (this.loopGuard.isLoop(incomingChain, String(action))) {
      console.warn(
        `[chbus] Loop detected on channel "${this.namespace ? `${this.namespace}:${this.name}` : this.name}" action "${String(action)}" from "${from}". Incoming chain: ${incomingChain.join(", ")}`,
      );
      return null;
    }

    // Generate a coordination ID for this emission, track it, and append it
    // to the outgoing chain so downstream channels can detect the loop.
    const coordinationId = crypto.randomUUID();
    this.loopGuard.track(coordinationId, String(action));
    const coordinationChain = [...incomingChain, coordinationId];

    return {
      id,
      namespace: this.namespace,
      channel: this.name,
      action,
      payload,
      from,
      coordinationChain,
      timestamp: Date.now(),
    };
  }

  // Delivers a message to all handlers matching the action.
  // Checks signal before each handler call — if aborted mid-fan-out, remaining
  // handlers are skipped. Already-running handlers receive the signal and are
  // responsible for bailing at their own async boundaries.
  private async deliver<A extends keyof C>(
    action: A,
    payload: C[A],
    message: Message<C, A>,
    signal: AbortSignal,
  ): Promise<SettledResult[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subs = this.subscribers.get(action) as Set<Handler<C, A>> | undefined;
    if (!subs || subs.size === 0) return [];

    const promises: Promise<void>[] = [];
    for (const handler of subs) {
      if (signal.aborted) break;
      promises.push(handler(payload, { message }, signal));
    }

    const settled = await Promise.allSettled(promises);
    return settled.map((result) => ({
      status: result.status,
      reason: result.status === "rejected" ? result.reason : undefined,
    }));
  }

  // Forwards a completed message to the Bus-provided debug wiretap callback.
  private forwardDebug<A extends keyof C>(message: Message<C, A>): void {
    const qualifiedChannel = this.namespace
      ? `${this.namespace}:${this.name}`
      : this.name;

    this.onEmit({
      namespace: this.namespace,
      channel: this.name,
      qualifiedChannel,
      action: String(message.action),
      payload: message.payload,
      from: message.from,
      coordinationChain: message.coordinationChain,
      timestamp: message.timestamp,
      messageId: message.id,
    });
  }

  private runMiddleware(message: Message<C>, done: () => void): void {
    let index = 0;

    const next: Next = () => {
      if (index < this.middlewares.length) {
        const mw = this.middlewares[index++];
        mw(message, next);
      } else {
        done();
      }
    };

    next();
  }

  // Shared helper for registering handlers.
  private addSubscriber<S>(
    map: Map<keyof C, Set<S>>,
    action: keyof C,
    subscriber: S,
  ): () => void {
    if (!map.has(action)) {
      map.set(action, new Set());
    }

    const set = map.get(action)!;
    set.add(subscriber);

    return () => {
      set.delete(subscriber);
      if (set.size === 0) {
        map.delete(action);
      }
    };
  }
}
