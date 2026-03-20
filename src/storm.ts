import type { StormConfig } from './types'

const DEFAULT_STORM_CONFIG: StormConfig = {
  maxMessages: 100,
  windowMs: 1000,
}

// Tracks per-sender message rates within a sliding time window.
// If a sender exceeds maxMessages within windowMs, subsequent
// messages are dropped and a warning is logged.
export class StormGuard {
  private readonly config: StormConfig
  private counters = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly channelName: string,
    config?: Partial<StormConfig>,
  ) {
    this.config = { ...DEFAULT_STORM_CONFIG, ...config }
  }

  // Returns true if the message is allowed through, false if it should be dropped.
  check(sender: string): boolean {
    const count = (this.counters.get(sender) ?? 0) + 1
    this.counters.set(sender, count)

    // Start the reset timer on the first message in this window.
    if (!this.timers.has(sender)) {
      const timer = setTimeout(() => {
        this.counters.delete(sender)
        this.timers.delete(sender)
      }, this.config.windowMs)
      this.timers.set(sender, timer)
    }

    if (count > this.config.maxMessages) {
      console.warn(
        `[chbus] Storm detected on channel "${this.channelName}" from sender "${sender}" — ${count} messages in ${this.config.windowMs}ms`,
      )
      return false
    }

    return true
  }

  destroy(): void {
    this.timers.forEach((t) => clearTimeout(t))
    this.timers.clear()
    this.counters.clear()
  }
}
