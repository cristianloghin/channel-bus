import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoopGuard } from './loop'

describe('LoopGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes a message with an empty coordination chain', () => {
    const guard = new LoopGuard()
    expect(guard.isLoop([], 'action')).toBe(false)
  })

  it('passes a message whose chain contains only unknown IDs', () => {
    const guard = new LoopGuard()
    guard.track('id-a', 'action')
    expect(guard.isLoop(['id-x', 'id-y'], 'action')).toBe(false)
  })

  it('drops a message whose chain contains an ID previously emitted by this guard for the same action', () => {
    const guard = new LoopGuard()
    guard.track('id-a', 'ping')
    expect(guard.isLoop(['id-a'], 'ping')).toBe(true)
  })

  it('passes a message whose chain contains an ID emitted for a different action', () => {
    const guard = new LoopGuard()
    guard.track('id-a', 'ping')
    expect(guard.isLoop(['id-a'], 'pong')).toBe(false)
  })

  it('detects a direct loop (A→B→A)', () => {
    const guardA = new LoopGuard()
    const guardB = new LoopGuard()

    // A emits — tracks coordId-a for action "ping"
    guardA.track('coordId-a', 'ping')
    const chainAfterA = ['coordId-a']

    // B receives and re-emits — checks chain, tracks coordId-b for action "ping"
    expect(guardB.isLoop(chainAfterA, 'ping')).toBe(false)
    guardB.track('coordId-b', 'ping')
    const chainAfterB = [...chainAfterA, 'coordId-b']

    // Message arrives back at A — A sees its own coordId-a in the chain for action "ping"
    expect(guardA.isLoop(chainAfterB, 'ping')).toBe(true)
  })

  it('detects an indirect loop (A→B→C→A)', () => {
    const guardA = new LoopGuard()
    const guardB = new LoopGuard()
    const guardC = new LoopGuard()

    guardA.track('id-a', 'ping')
    const chain1 = ['id-a']

    expect(guardB.isLoop(chain1, 'ping')).toBe(false)
    guardB.track('id-b', 'ping')
    const chain2 = [...chain1, 'id-b']

    expect(guardC.isLoop(chain2, 'ping')).toBe(false)
    guardC.track('id-c', 'ping')
    const chain3 = [...chain2, 'id-c']

    // Back at A — detects own id for the same action
    expect(guardA.isLoop(chain3, 'ping')).toBe(true)
  })

  it('two guards with overlapping IDs do not interfere with each other', () => {
    const guardA = new LoopGuard()
    const guardB = new LoopGuard()

    guardA.track('shared-id', 'ping')
    guardB.track('shared-id', 'ping')

    // guardA seeing its own ID in a chain is a loop
    expect(guardA.isLoop(['shared-id'], 'ping')).toBe(true)
    // guardB seeing the same ID in a chain is also a loop (it tracked the same value)
    expect(guardB.isLoop(['shared-id'], 'ping')).toBe(true)

    // But a fresh guard seeing that ID is not a loop
    const guardC = new LoopGuard()
    expect(guardC.isLoop(['shared-id'], 'ping')).toBe(false)
  })

  it('evicts the oldest entry when the map reaches 10,000', () => {
    const guard = new LoopGuard()
    const firstId = 'first-id'

    guard.track(firstId, 'ping')
    for (let i = 0; i < 9_999; i++) {
      guard.track(`id-${i}`, 'ping')
    }

    // firstId should still be present — limit not yet exceeded on next track
    expect(guard.isLoop([firstId], 'ping')).toBe(true)

    // One more push causes eviction of firstId
    guard.track('overflow-id', 'ping')
    expect(guard.isLoop([firstId], 'ping')).toBe(false)
  })

  it('destroy() clears all tracked IDs', () => {
    const guard = new LoopGuard()
    guard.track('id-1', 'ping')
    guard.destroy()
    expect(guard.isLoop(['id-1'], 'ping')).toBe(false)
  })
})
