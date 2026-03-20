import type {
  BusConfig,
  ChannelContract,
  ChannelOptions,
  DebugMessage,
  StormConfig,
} from './types'
import { Channel } from './channel'
import { DebugChannel } from './debug'

const DEFAULT_STORM_CONFIG: StormConfig = {
  maxMessages: 100,
  windowMs: 1000,
}

// ── NamespacedBus ─────────────────────────────────────────────────────────────
//
// A thin proxy over the root Bus that scopes all channel creation to a single
// namespace. Channels created via a NamespacedBus are registered on the root
// Bus under the fully qualified key `namespace:channel`.
//
// This is the intended interface for third-party libraries — it exposes only
// channel() so libraries cannot call namespace() or onDebug() themselves.
// Export it as a type so consumer code can declare what it accepts:
//
//   function createVideoPlayer({ bus }: { bus: NamespacedBus }) { ... }
//
export class NamespacedBus {
  readonly namespace: string

  // The factory is provided by the root Bus, keeping the channel registry
  // internal to Bus while allowing NamespacedBus to remain a pure proxy.
  constructor(
    namespace: string,
    private readonly createChannel: <C extends ChannelContract>(
      name: string,
      options?: ChannelOptions,
    ) => Channel<C>,
  ) {
    this.namespace = namespace
  }

  channel<C extends ChannelContract>(
    name: string,
    options?: ChannelOptions,
  ): Channel<C> {
    return this.createChannel<C>(name, options)
  }
}

// ── Bus ───────────────────────────────────────────────────────────────────────

export class Bus {
  // Registry keyed by fully qualified channel name (e.g. 'vms:playback').
  // Channels created on the root Bus without a namespace use the bare name.
  private channels = new Map<string, Channel<ChannelContract>>()
  private debugChannel = new DebugChannel()
  private stormConfig: StormConfig

  constructor(config?: BusConfig) {
    this.stormConfig = { ...DEFAULT_STORM_CONFIG, ...config?.storm }
  }

  // Creates or retrieves an unnamespaced channel by name.
  // Throws if name is 'debug' (reserved for the internal wiretap).
  channel<C extends ChannelContract>(
    name: string,
    options?: ChannelOptions,
  ): Channel<C> {
    if (name === 'debug') {
      throw new Error(
        '[chbus] "debug" is a reserved channel name. Use bus.onDebug() to access the debug wiretap.',
      )
    }
    return this.getOrCreate<C>(name, '', options)
  }

  // Returns a NamespacedBus proxy. Multiple calls with the same name return
  // independent proxies, but they all write to the same underlying channel registry.
  namespace(name: string): NamespacedBus {
    return new NamespacedBus(name, <C extends ChannelContract>(
      channelName: string,
      options?: ChannelOptions,
    ) => this.getOrCreate<C>(channelName, name, options))
  }

  // Subscribe to the debug wiretap. Returns an unsubscribe function.
  // Only available on the root Bus — NamespacedBus does not expose this.
  onDebug(subscriber: (msg: DebugMessage) => void): () => void {
    return this.debugChannel.subscribe(subscriber)
  }

  // Destroys all channels and clears internal state.
  destroy(): void {
    this.channels.forEach((ch) => ch.destroy())
    this.channels.clear()
    this.debugChannel.destroy()
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private getOrCreate<C extends ChannelContract>(
    name: string,
    namespace: string,
    options?: ChannelOptions,
  ): Channel<C> {
    const key = namespace ? `${namespace}:${name}` : name

    if (this.channels.has(key)) {
      return this.channels.get(key) as Channel<C>
    }

    const stormConfig: StormConfig = options?.storm
      ? { ...this.stormConfig, ...options.storm }
      : this.stormConfig

    const ch = new Channel<C>(
      name,
      namespace,
      stormConfig,
      (msg: DebugMessage) => this.debugChannel.forward(msg),
    )

    this.channels.set(key, ch as Channel<ChannelContract>)
    return ch
  }
}

export function createBus(config?: BusConfig): Bus {
  return new Bus(config)
}
