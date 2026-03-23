// Maximum number of coordination IDs retained per channel.
// When the limit is reached the oldest ID is evicted (LRU) before the new
// one is added, bounding memory use in long-running applications while
// still providing reliable loop detection for any realistic cascade depth.
const MAX_SIZE = 10_000

// Tracks coordination IDs (and the action they were emitted for) by this channel.
// Used to detect message loops — both direct (A→B→A) and indirect (A→B→C→A).
// Loop detection is action-scoped: a chain that passes through this channel for
// action "ping" does not block a downstream emission of a different action "pong"
// on the same channel.
export class LoopGuard {
  private emittedIds = new Map<string, string>() // coordinationId → action

  // Returns true if any ID in the incoming coordination chain was previously
  // emitted by this channel for the same action — i.e. this message has looped
  // back to its origin.
  isLoop(coordinationChain: string[], action: string): boolean {
    return coordinationChain.some((id) => this.emittedIds.get(id) === action)
  }

  // Records a new coordination ID and its associated action as emitted by this
  // channel. Evicts the oldest entry if the map has reached MAX_SIZE.
  track(id: string, action: string): void {
    if (this.emittedIds.size >= MAX_SIZE) {
      const oldest = this.emittedIds.keys().next().value as string
      this.emittedIds.delete(oldest)
    }
    this.emittedIds.set(id, action)
  }

  destroy(): void {
    this.emittedIds.clear()
  }
}
