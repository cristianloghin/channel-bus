import type { BufferConfig, ChannelContract, Message } from "./types";

export class MessageBuffer<C extends ChannelContract> {
  private queue: Message<C>[] = [];
  private openActions = new Set<keyof C>();
  private claims = new Map<keyof C, object>();

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

  claim(action: keyof C, claimant: object): void {
    const existing = this.claims.get(action);
    if (existing !== undefined && existing !== claimant) {
      throw new Error(
        `[chbus] Action "${String(action)}" on channel "${this.channelName}" is already claimed by another mailbox`,
      );
    }
    this.claims.set(action, claimant);
  }

  open(claimant: object): Message<C>[] {
    this.evictExpired();
    const actionSet = new Set<keyof C>();
    this.claims.forEach((c, a) => {
      if (c === claimant) {
        actionSet.add(a);
      }
    });
    actionSet.forEach((a) => {
      this.openActions.add(a);
    });
    const claimedMessages = this.queue.filter((m) => actionSet.has(m.action));
    const unclaimedMessages = this.queue.filter(
      (m) => !actionSet.has(m.action),
    );

    this.queue = unclaimedMessages;
    return claimedMessages;
  }

  // Frees every claim held by this claimant, opened or not. Open actions stay
  // open (the gate never re-arms) — releasing only frees ownership, so a
  // successor mailbox can register the same actions after this one is
  // destroyed. Claims police concurrent mailboxes, not dead ones.
  release(claimant: object): void {
    for (const [action, holder] of this.claims) {
      if (holder === claimant) this.claims.delete(action);
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
    this.claims.clear();
  }
}
