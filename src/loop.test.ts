import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoopGuard } from './loop'

describe('LoopGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes a message with an empty coordination chain', () => {
    const guard = new LoopGuard()
    expect(guard.isLoop([])).toBe(false)
  })

  it('passes a message whose chain contains only unknown IDs', () => {
    const guard = new LoopGuard()
    guard.track('id-a')
    expect(guard.isLoop(['id-x', 'id-y'])).toBe(false)
  })

  it('drops a message whose chain contains an ID previously emitted by this guard', () => {
    const guard = new LoopGuard()
    guard.track('id-a')
    expect(guard.isLoop(['id-a'])).toBe(true)
  })

  it('detects a direct loop (A→B→A)', () => {
    const guardA = new LoopGuard()
    const guardB = new LoopGuard()

    // A emits — tracks coordId-a
    guardA.track('coordId-a')
    const chainAfterA = ['coordId-a']

    // B receives and re-emits — checks chain, tracks coordId-b
    expect(guardB.isLoop(chainAfterA)).toBe(false)
    guardB.track('coordId-b')
    const chainAfterB = [...chainAfterA, 'coordId-b']

    // Message arrives back at A — A sees its own coordId-a in the chain
    expect(guardA.isLoop(chainAfterB)).toBe(true)
  })

  it('detects an indirect loop (A→B→C→A)', () => {
    const guardA = new LoopGuard()
    const guardB = new LoopGuard()
    const guardC = new LoopGuard()

    guardA.track('id-a')
    const chain1 = ['id-a']

    expect(guardB.isLoop(chain1)).toBe(false)
    guardB.track('id-b')
    const chain2 = [...chain1, 'id-b']

    expect(guardC.isLoop(chain2)).toBe(false)
    guardC.track('id-c')
    const chain3 = [...chain2, 'id-c']

    // Back at A — detects own id
    expect(guardA.isLoop(chain3)).toBe(true)
  })

  it('two guards with overlapping IDs do not interfere with each other', () => {
    const guardA = new LoopGuard()
    const guardB = new LoopGuard()

    guardA.track('shared-id')
    guardB.track('shared-id')

    // guardA seeing its own ID in a chain is a loop
    expect(guardA.isLoop(['shared-id'])).toBe(true)
    // guardB seeing the same ID in a chain is also a loop (it tracked the same value)
    expect(guardB.isLoop(['shared-id'])).toBe(true)

    // But a fresh guard seeing that ID is not a loop
    const guardC = new LoopGuard()
    expect(guardC.isLoop(['shared-id'])).toBe(false)
  })

  it('evicts the oldest entry when the set reaches 10,000', () => {
    const guard = new LoopGuard()
    const firstId = 'first-id'

    guard.track(firstId)
    for (let i = 0; i < 9_999; i++) {
      guard.track(`id-${i}`)
    }

    // firstId should still be present — limit not yet exceeded on next track
    expect(guard.isLoop([firstId])).toBe(true)

    // One more push causes eviction of firstId
    guard.track('overflow-id')
    expect(guard.isLoop([firstId])).toBe(false)
  })

  it('destroy() clears all tracked IDs', () => {
    const guard = new LoopGuard()
    guard.track('id-1')
    guard.destroy()
    expect(guard.isLoop(['id-1'])).toBe(false)
  })
})
