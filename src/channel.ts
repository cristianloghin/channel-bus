import type {
  AsyncSubscriber,
  ChannelContract,
  DebugMessage,
  EmitOptions,
  Message,
  Middleware,
  Next,
  SettledResult,
  StormConfig,
  Subscriber,
} from './types'
import { LoopGuard } from './loop'
import { StormGuard } from './storm'

export class Channel<C extends ChannelContract> {
  readonly name: string       // unqualified channel name
  readonly namespace: string  // '' if created directly on the root Bus

  private middlewares: Middleware<C>[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private syncSubscribers = new Map<keyof C, Set<Subscriber<C, any>>>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private asyncSubscribers = new Map<keyof C, Set<AsyncSubscriber<C, any>>>()
  private stormGuard: StormGuard
  private loopGuard = new LoopGuard()
  private destroyed = false

  // Injected by the Bus at construction time — forwards every emitted message
  // to the debug wiretap. The channel itself is unaware of the debug channel.
  private readonly onEmit: (msg: DebugMessage) => void

  constructor(
    name: string,
    namespace: string,
    stormConfig: StormConfig,
    onEmit: (msg: DebugMessage) => void,
  ) {
    this.name = name
    this.namespace = namespace
    // Pass the qualified name so storm warnings include full context.
    const qualifiedName = namespace ? `${namespace}:${name}` : name
    this.stormGuard = new StormGuard(qualifiedName, stormConfig)
    this.onEmit = onEmit
  }

  // ── Middleware ──────────────────────────────────────────────────────────────

  // Appends to the middleware pipeline. Runs for both emit() and emitAsync().
  // Middleware runs in insertion order and must call next() to continue.
  use(middleware: Middleware<C>): this {
    this.middlewares.push(middleware)
    return this
  }

  // ── Sync track ──────────────────────────────────────────────────────────────

  // Register a synchronous subscriber. Returns an unsubscribe function.
  // Sync subscribers are only called by emit(), never by emitAsync().
  // Pass { signal } to automatically unsubscribe when the signal is aborted.
  on<A extends keyof C>(
    action: A,
    subscriber: Subscriber<C, A>,
    options?: { signal?: AbortSignal },
  ): () => void {
    if (options?.signal?.aborted) return () => {}
    const unsub = this.addSubscriber(this.syncSubscribers, action, subscriber)
    options?.signal?.addEventListener('abort', unsub, { once: true })
    return unsub
  }

  // Synchronous fire-and-forget fan-out. Delivers only to subscribers registered
  // with on(). Any Promises returned by subscribers are ignored.
  emit<A extends keyof C>(
    action: A,
    payload: C[A],
    options?: EmitOptions,
  ): void {
    if (this.destroyed) {
      console.warn(`[chbus] emit() called on destroyed channel "${this.name}"`)
      return
    }

    const message = this.buildMessage(action, payload, options)
    if (!message) return

    let passed = false
    this.runMiddleware(message, () => {
      passed = true
      this.deliverSync(action, payload, message)
      this.forwardDebug(message)
    })
    void passed // middleware drop is intentional and silent
  }

  // ── Async track ─────────────────────────────────────────────────────────────

  // Register an asynchronous subscriber. Returns an unsubscribe function.
  // Async subscribers are only called by emitAsync(), never by emit().
  // Pass { signal } to automatically unsubscribe when the signal is aborted.
  onAsync<A extends keyof C>(
    action: A,
    subscriber: AsyncSubscriber<C, A>,
    options?: { signal?: AbortSignal },
  ): () => void {
    if (options?.signal?.aborted) return () => {}
    const unsub = this.addSubscriber(this.asyncSubscribers, action, subscriber)
    options?.signal?.addEventListener('abort', unsub, { once: true })
    return unsub
  }

  // Async fan-out. Delivers only to subscribers registered with onAsync().
  // Returns a Promise that resolves when all async subscribers have settled.
  // Uses Promise.allSettled — a rejecting subscriber does not prevent others
  // from running. Returns [] if the message is dropped or no subscribers match.
  async emitAsync<A extends keyof C>(
    action: A,
    payload: C[A],
    options?: EmitOptions,
  ): Promise<SettledResult[]> {
    if (this.destroyed) {
      console.warn(`[chbus] emitAsync() called on destroyed channel "${this.name}"`)
      return []
    }

    const message = this.buildMessage(action, payload, options)
    if (!message) return []

    // Since runMiddleware is synchronous, deliveryPromise will be set (or
    // remain null) before runMiddleware returns. A null value means middleware
    // dropped the message — resolve immediately with empty results.
    let deliveryPromise: Promise<SettledResult[]> | null = null

    this.runMiddleware(message, () => {
      deliveryPromise = this.deliverAsync(action, payload, message).then(
        (results) => {
          this.forwardDebug(message)
          return results
        },
      )
    })

    return deliveryPromise ?? []
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  destroy(): void {
    this.destroyed = true
    this.stormGuard.destroy()
    this.loopGuard.destroy()
    this.syncSubscribers.clear()
    this.asyncSubscribers.clear()
    this.middlewares.length = 0
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  // Validates storm and loop constraints, builds and returns the Message.
  // Returns null if the message should be dropped.
  private buildMessage<A extends keyof C>(
    action: A,
    payload: C[A],
    options?: EmitOptions,
  ): Message<C, A> | null {
    const from = options?.from ?? 'anonymous'
    const incomingChain = options?.coordinationChain ?? []
    const id = crypto.randomUUID()

    // Storm check — drop if sender is flooding this channel.
    if (!this.stormGuard.check(from)) return null

    // Loop check — drop if any ID in the chain was emitted by this channel.
    if (this.loopGuard.isLoop(incomingChain)) {
      console.warn(
        `[chbus] Loop detected on channel "${this.namespace ? `${this.namespace}:${this.name}` : this.name}" action "${String(action)}" from "${from}"`,
      )
      return null
    }

    // Generate a coordination ID for this emission, track it, and append it
    // to the outgoing chain so downstream channels can detect the loop.
    const coordinationId = crypto.randomUUID()
    this.loopGuard.track(coordinationId)
    const coordinationChain = [...incomingChain, coordinationId]

    return {
      id,
      namespace: this.namespace,
      channel: this.name,
      action,
      payload,
      from,
      coordinationChain,
      timestamp: Date.now(),
    }
  }

  // Delivers a message to all sync subscribers matching the action.
  private deliverSync<A extends keyof C>(
    action: A,
    payload: C[A],
    message: Message<C, A>,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subs = this.syncSubscribers.get(action) as Set<Subscriber<C, A>> | undefined
    if (!subs) return

    subs.forEach((subscriber) => {
      try {
        subscriber(payload, { message })
      } catch (error) {
        console.error(
          `[chbus] Error in subscriber on channel "${this.name}" action "${String(action)}":`,
          error,
        )
      }
    })
  }

  // Delivers a message to all async subscribers matching the action.
  // Uses Promise.allSettled so one failing subscriber cannot block others.
  private async deliverAsync<A extends keyof C>(
    action: A,
    payload: C[A],
    message: Message<C, A>,
  ): Promise<SettledResult[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subs = this.asyncSubscribers.get(action) as Set<AsyncSubscriber<C, A>> | undefined
    if (!subs || subs.size === 0) return []

    const settled = await Promise.allSettled(
      Array.from(subs).map((subscriber) => subscriber(payload, { message })),
    )

    return settled.map((result) => ({
      status: result.status,
      reason: result.status === 'rejected' ? result.reason : undefined,
    }))
  }

  // Forwards a completed message to the Bus-provided debug wiretap callback.
  private forwardDebug<A extends keyof C>(message: Message<C, A>): void {
    const qualifiedChannel = this.namespace
      ? `${this.namespace}:${this.name}`
      : this.name

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
    })
  }

  private runMiddleware(message: Message<C>, done: () => void): void {
    let index = 0

    const next: Next = () => {
      if (index < this.middlewares.length) {
        const mw = this.middlewares[index++]
        mw(message, next)
      } else {
        done()
      }
    }

    next()
  }

  // Shared helper for registering subscribers on either track.
  private addSubscriber<S>(
    map: Map<keyof C, Set<S>>,
    action: keyof C,
    subscriber: S,
  ): () => void {
    if (!map.has(action)) {
      map.set(action, new Set())
    }

    const set = map.get(action)!
    set.add(subscriber)

    return () => {
      set.delete(subscriber)
      if (set.size === 0) {
        map.delete(action)
      }
    }
  }
}
