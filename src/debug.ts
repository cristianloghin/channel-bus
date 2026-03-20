import type { DebugMessage } from './types'

// Internal wiretap channel. Not a Channel<C> — it has no contract, no middleware,
// no storm/loop guards. It only receives forwarded DebugMessages from every
// other channel and fans them out to registered debug subscribers.
// Not part of the public API — the Bus exposes access via bus.onDebug().
export class DebugChannel {
  private subscribers = new Set<(msg: DebugMessage) => void>()

  subscribe(handler: (msg: DebugMessage) => void): () => void {
    this.subscribers.add(handler)
    return () => {
      this.subscribers.delete(handler)
    }
  }

  forward(msg: DebugMessage): void {
    this.subscribers.forEach((handler) => {
      try {
        handler(msg)
      } catch (error) {
        console.error('[chbus] Error in debug subscriber:', error)
      }
    })
  }

  destroy(): void {
    this.subscribers.clear()
  }
}
