import { Channel } from "./channel";
import { DebugChannel } from "./debug";
import type { ChannelRulesMap } from "./mailbox";
import { Mailbox } from "./mailbox";
import type {
  BusConfig,
  ChannelContract,
  ChannelOptions,
  DebugMessage,
  StormConfig,
} from "./types";

const DEFAULT_STORM_CONFIG: StormConfig = {
  maxMessages: 100,
  windowMs: 1000,
};

function stormConfigEquals(a: StormConfig, b: StormConfig): boolean {
  return a.maxMessages === b.maxMessages && a.windowMs === b.windowMs;
}

// ── NamespacedBus ─────────────────────────────────────────────────────────────
//
// A thin proxy over the root Bus that scopes all channel creation to a single
// namespace. Channels created via a NamespacedBus are registered on the root
// Bus under the fully qualified key `namespace:channel`.
//
// This is the intended interface for third-party libraries — it exposes only
// channel() and destroy() so libraries cannot call namespace() or onDebug().
// Export it as a type so consumer code can declare what it accepts:
//
//   function createVideoPlayer({ bus }: { bus: NamespacedBus }) { ... }
//
export class NamespacedBus {
  readonly namespace: string;

  // The factory is provided by the root Bus, keeping the channel registry
  // internal to Bus while allowing NamespacedBus to remain a pure proxy.
  constructor(
    namespace: string,
    private readonly createChannel: <C extends ChannelContract>(
      name: string,
      options?: ChannelOptions,
    ) => Channel<C>,
    private readonly destroyNamespace: () => void,
  ) {
    this.namespace = namespace;
  }

  channel<C extends ChannelContract>(
    name: string,
    options?: ChannelOptions,
  ): Channel<C> {
    return this.createChannel<C>(name, options);
  }

  destroy(): void {
    this.destroyNamespace();
  }
}

// ── Bus ───────────────────────────────────────────────────────────────────────

export class Bus {
  // Registry keyed by fully qualified channel name (e.g. 'vms:playback').
  // Channels created on the root Bus without a namespace use the bare name.
  private channels = new Map<string, Channel<ChannelContract>>();
  private debugChannel = new DebugChannel();
  private stormConfig: StormConfig;

  constructor(config?: BusConfig) {
    this.stormConfig = { ...DEFAULT_STORM_CONFIG, ...config?.storm };
  }

  // Creates or retrieves an unnamespaced channel by name.
  // Throws if name is 'debug' (reserved for the internal wiretap).
  channel<C extends ChannelContract>(
    name: string,
    options?: ChannelOptions,
  ): Channel<C> {
    if (name === "debug") {
      throw new Error(
        '[chbus] "debug" is a reserved channel name. Use bus.onDebug() to access the debug wiretap.',
      );
    }
    return this.getOrCreate<C>(name, "", options);
  }

  // Returns a NamespacedBus proxy. Multiple calls with the same name return
  // independent proxies, but they all write to the same underlying channel registry.
  namespace(name: string): NamespacedBus {
    return new NamespacedBus(
      name,
      <C extends ChannelContract>(
        channelName: string,
        options?: ChannelOptions,
      ) => this.getOrCreate<C>(channelName, name, options),
      () => this.destroyNamespace(name),
    );
  }

  // Subscribe to the debug wiretap. Returns an unsubscribe function.
  // Only available on the root Bus — NamespacedBus does not expose this.
  onDebug(subscriber: (msg: DebugMessage) => void): () => void {
    return this.debugChannel.subscribe(subscriber);
  }

  // Creates a Mailbox that subscribes to one or more channels on behalf of its
  // owner, serialises message execution per-channel, and applies interrupt rules.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createMailbox<Channels extends Record<string, Channel<any>>>(
    channels: Channels,
    rules?: ChannelRulesMap<Channels>,
  ): Mailbox<Channels> {
    return new Mailbox(channels, rules);
  }

  // Destroys all channels and clears internal state.
  destroy(): void {
    this.channels.forEach((ch) => ch.destroy());
    this.channels.clear();
    this.debugChannel.destroy();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private destroyNamespace(namespace: string): void {
    for (const [key, channel] of this.channels) {
      if (channel.namespace === namespace) {
        channel.destroy();
        this.channels.delete(key);
      }
    }
  }

  private getOrCreate<C extends ChannelContract>(
    name: string,
    namespace: string,
    options?: ChannelOptions,
  ): Channel<C> {
    const key = namespace ? `${namespace}:${name}` : name;

    const resolved: StormConfig = options?.storm
      ? { ...this.stormConfig, ...options.storm }
      : this.stormConfig;

    const existing = this.channels.get(key);
    if (existing) {
      // Options are applied by whichever party creates the channel first.
      // An optionless call is pure access and always succeeds; a call whose
      // options resolve to a different config than the live channel's would
      // otherwise be silently ignored — make that loud instead.
      if (
        options?.storm &&
        !stormConfigEquals(existing.stormConfig, resolved)
      ) {
        throw new Error(
          `[chbus] channel "${key}" already exists with storm config ` +
            `${JSON.stringify(existing.stormConfig)}, but this access requested ` +
            `${JSON.stringify(resolved)}. Options are applied by whichever party ` +
            `creates the channel first — pass no options to access the channel as-is.`,
        );
      }
      return existing as Channel<C>;
    }

    const ch = new Channel<C>(name, namespace, resolved, (msg: DebugMessage) =>
      this.debugChannel.forward(msg),
    );

    this.channels.set(key, ch as Channel<ChannelContract>);
    return ch;
  }
}

export function createBus(config?: BusConfig): Bus {
  return new Bus(config);
}
