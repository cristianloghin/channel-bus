import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StormGuard } from './storm'

describe('StormGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('allows messages within the threshold', () => {
    const guard = new StormGuard('test', { maxMessages: 3, windowMs: 1000 })
    expect(guard.check('sender')).toBe(true)
    expect(guard.check('sender')).toBe(true)
    expect(guard.check('sender')).toBe(true)
  })

  it('drops the message that exceeds the threshold', () => {
    const guard = new StormGuard('test', { maxMessages: 3, windowMs: 1000 })
    guard.check('sender')
    guard.check('sender')
    guard.check('sender')
    expect(guard.check('sender')).toBe(false)
  })

  it('logs a [chbus] warning when a message is dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const guard = new StormGuard('my-channel', { maxMessages: 1, windowMs: 1000 })
    guard.check('svc')
    guard.check('svc')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[chbus]'),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('my-channel'),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('svc'),
    )
  })

  it('resets the counter after windowMs and allows messages again', () => {
    const guard = new StormGuard('test', { maxMessages: 2, windowMs: 500 })
    guard.check('sender')
    guard.check('sender')
    expect(guard.check('sender')).toBe(false)

    vi.advanceTimersByTime(500)

    expect(guard.check('sender')).toBe(true)
  })

  it('tracks different senders independently', () => {
    const guard = new StormGuard('test', { maxMessages: 1, windowMs: 1000 })
    guard.check('alice')
    // alice is at limit; bob is not
    expect(guard.check('alice')).toBe(false)
    expect(guard.check('bob')).toBe(true)
  })

  it('uses a custom config when provided', () => {
    const guard = new StormGuard('test', { maxMessages: 5, windowMs: 2000 })
    for (let i = 0; i < 5; i++) guard.check('sender')
    expect(guard.check('sender')).toBe(false)
  })

  it('destroy() clears all timers without throwing', () => {
    const guard = new StormGuard('test', { maxMessages: 10, windowMs: 1000 })
    guard.check('sender')
    expect(() => guard.destroy()).not.toThrow()
  })
})
