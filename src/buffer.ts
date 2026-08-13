import type { BufferConfig, ChannelContract, Message } from "./types";

export class MessageBuffer<C extends ChannelContract> {
  private queue: Message<C>[] = [];
  private openActions = new Set<keyof C>();

  constructor(
    private readonly channelName: string, // qualified, for warnings
    private readonly config: BufferConfig,
  ) {}

  isOpen(action: keyof C): boolean {
    return this.openActions.has(action);
  }

  push(message: Message<C>): void {
    this.evictExpired();
    this.queue.push(message);

    while (this.queue.length > this.config.maxMessages) {
      const msg = this.queue.shift();
      console.warn(
        `[chbus] Buffer overflow on channel "${this.channelName}" - dropped "${String(msg?.action)}" (maxMessages: ${this.config.maxMessages})`,
      );
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.config.maxAgeMs;

    while (this.queue.length > 0 && this.queue[0].timestamp < cutoff) {
      const msg = this.queue.shift();
      console.warn(
        `[chbus] Message expired on channel "${this.channelName}" - dropped "${String(msg?.action)}" with timestamp: "${msg?.timestamp}" (maxAgeMs: ${this.config.maxAgeMs})`,
      );
    }
  }

  get size(): number {
    this.evictExpired();
    return this.queue.length;
  }

  destroy(): void {
    this.queue = [];
    this.openActions.clear();
  }
}
