// Maximum number of coordination IDs retained per channel.
// When the limit is reached the oldest ID is evicted (LRU) before the new
// one is added, bounding memory use in long-running applications while
// still providing reliable loop detection for any realistic cascade depth.
const MAX_SIZE = 10_000

// Tracks coordination IDs that this channel has emitted.
// Used to detect message loops — both direct (A→B→A) and indirect (A→B→C→A).
export class LoopGuard {
  private emittedIds = new Set<string>()

  // Returns true if any ID in the incoming coordination chain was previously
  // emitted by this channel — i.e. this message has looped back to its origin.
  isLoop(coordinationChain: string[]): boolean {
    return coordinationChain.some((id) => this.emittedIds.has(id))
  }

  // Records a new coordination ID as emitted by this channel.
  // Evicts the oldest entry if the set has reached MAX_SIZE.
  track(id: string): void {
    if (this.emittedIds.size >= MAX_SIZE) {
      const oldest = this.emittedIds.values().next().value as string
      this.emittedIds.delete(oldest)
    }
    this.emittedIds.add(id)
  }

  destroy(): void {
    this.emittedIds.clear()
  }
}
