import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel } from './channel'
import type { DebugMessage } from './types'

type TestContract = {
  'test:ping': { value: number }
  'test:pong': { value: string }
}

const STORM_CONFIG = { maxMessages: 100, windowMs: 1000 }
const noop = () => {}

function makeChannel(onEmit = noop as (msg: DebugMessage) => void) {
  return new Channel<TestContract>('test', '', STORM_CONFIG, onEmit)
}

describe('Channel — sync track', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers the correct payload and meta to a matching subscriber', () => {
    const ch = makeChannel()
    const received: unknown[] = []
    ch.on('test:ping', (payload, { message }) => {
      received.push(payload)
      received.push(message.action)
    })
    ch.emit('test:ping', { value: 42 })
    expect(received).toEqual([{ value: 42 }, 'test:ping'])
  })

  it('does not deliver to subscribers registered for a different action', () => {
    const ch = makeChannel()
    const cb = vi.fn()
    ch.on('test:pong', cb)
    ch.emit('test:ping', { value: 1 })
    expect(cb).not.toHaveBeenCalled()
  })

  it('delivers to multiple subscribers on the same action', () => {
    const ch = makeChannel()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    ch.on('test:ping', cb1)
    ch.on('test:ping', cb2)
    ch.emit('test:ping', { value: 7 })
    expect(cb1).toHaveBeenCalledOnce()
    expect(cb2).toHaveBeenCalledOnce()
  })

  it('unsubscribe function stops delivery', () => {
    const ch = makeChannel()
    const cb = vi.fn()
    const unsub = ch.on('test:ping', cb)
    unsub()
    ch.emit('test:ping', { value: 1 })
    expect(cb).not.toHaveBeenCalled()
  })

  it('runs middleware in insertion order', () => {
    const ch = makeChannel()
    const order: number[] = []
    ch.use((_, next) => { order.push(1); next() })
    ch.use((_, next) => { order.push(2); next() })
    ch.emit('test:ping', { value: 0 })
    expect(order).toEqual([1, 2])
  })

  it('middleware that does not call next() prevents delivery', () => {
    const ch = makeChannel()
    const cb = vi.fn()
    ch.use((_msg, _next) => { /* deliberately does not call next */ })
    ch.on('test:ping', cb)
    ch.emit('test:ping', { value: 1 })
    expect(cb).not.toHaveBeenCalled()
  })

  it('applies storm check — drops message from a flooding sender', () => {
    const ch = new Channel<TestContract>('test', '', { maxMessages: 2, windowMs: 1000 }, noop)
    const cb = vi.fn()
    ch.on('test:ping', cb)
    ch.emit('test:ping', { value: 1 }, { from: 'spammer' })
    ch.emit('test:ping', { value: 2 }, { from: 'spammer' })
    ch.emit('test:ping', { value: 3 }, { from: 'spammer' }) // dropped
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('applies loop check — drops message with own coordination ID in the chain', () => {
    const ch = makeChannel()
    const cb = vi.fn()
    ch.on('test:ping', cb)

    let capturedChain: string[] = []
    ch.on('test:ping', (_, { message }) => {
      capturedChain = message.coordinationChain
    })
    ch.emit('test:ping', { value: 1 })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Re-emit propagating the same chain — this channel's ID is already in it
    ch.emit('test:ping', { value: 2 }, { coordinationChain: capturedChain })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[chbus]'))
    // Second emit was dropped
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('does not deliver to async subscribers registered with onAsync()', () => {
    const ch = makeChannel()
    const asyncCb = vi.fn().mockResolvedValue(undefined)
    ch.onAsync('test:ping', asyncCb)
    ch.emit('test:ping', { value: 1 })
    expect(asyncCb).not.toHaveBeenCalled()
  })

  it('abort signal removes the subscriber when aborted', () => {
    const ch = makeChannel()
    const cb = vi.fn()
    const controller = new AbortController()
    ch.on('test:ping', cb, { signal: controller.signal })
    ch.emit('test:ping', { value: 1 })
    controller.abort()
    ch.emit('test:ping', { value: 2 })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('abort signal already aborted — subscriber is never registered', () => {
    const ch = makeChannel()
    const cb = vi.fn()
    const controller = new AbortController()
    controller.abort()
    ch.on('test:ping', cb, { signal: controller.signal })
    ch.emit('test:ping', { value: 1 })
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('Channel — async track', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delivers the correct payload and meta to a matching async subscriber', async () => {
    const ch = makeChannel()
    const received: unknown[] = []
    ch.onAsync('test:ping', async (payload, { message }) => {
      received.push(payload)
      received.push(message.action)
    })
    await ch.emitAsync('test:ping', { value: 99 })
    expect(received).toEqual([{ value: 99 }, 'test:ping'])
  })

  it('resolves after all async subscribers have settled', async () => {
    const ch = makeChannel()
    const order: string[] = []
    ch.onAsync('test:ping', async () => {
      await Promise.resolve()
      order.push('first')
    })
    ch.onAsync('test:ping', async () => {
      await Promise.resolve()
      order.push('second')
    })
    await ch.emitAsync('test:ping', { value: 0 })
    expect(order).toHaveLength(2)
  })

  it('uses allSettled — a rejecting subscriber does not prevent others from running', async () => {
    const ch = makeChannel()
    const ran: boolean[] = []
    ch.onAsync('test:ping', async () => { throw new Error('boom') })
    ch.onAsync('test:ping', async () => { ran.push(true) })
    const results = await ch.emitAsync('test:ping', { value: 0 })
    expect(ran).toEqual([true])
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
  })

  it('returns SettledResult[] reflecting each subscriber outcome', async () => {
    const ch = makeChannel()
    ch.onAsync('test:ping', async () => { /* ok */ })
    ch.onAsync('test:ping', async () => { throw new Error('fail') })
    const results = await ch.emitAsync('test:ping', { value: 0 })
    expect(results).toHaveLength(2)
    const statuses = results.map(r => r.status).sort()
    expect(statuses).toEqual(['fulfilled', 'rejected'])
  })

  it('does not deliver to sync subscribers registered with on()', async () => {
    const ch = makeChannel()
    const syncCb = vi.fn()
    ch.on('test:ping', syncCb)
    await ch.emitAsync('test:ping', { value: 1 })
    expect(syncCb).not.toHaveBeenCalled()
  })

  it('abort signal removes the async subscriber when aborted', async () => {
    const ch = makeChannel()
    const cb = vi.fn().mockResolvedValue(undefined)
    const controller = new AbortController()
    ch.onAsync('test:ping', cb, { signal: controller.signal })
    await ch.emitAsync('test:ping', { value: 1 })
    controller.abort()
    await ch.emitAsync('test:ping', { value: 2 })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('abort signal already aborted — async subscriber is never registered', async () => {
    const ch = makeChannel()
    const cb = vi.fn().mockResolvedValue(undefined)
    const controller = new AbortController()
    controller.abort()
    ch.onAsync('test:ping', cb, { signal: controller.signal })
    await ch.emitAsync('test:ping', { value: 1 })
    expect(cb).not.toHaveBeenCalled()
  })

  it('returns [] when no async subscribers are registered', async () => {
    const ch = makeChannel()
    const results = await ch.emitAsync('test:ping', { value: 1 })
    expect(results).toEqual([])
  })
})

describe('Channel — shared concerns', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('both emit() and emitAsync() run the same middleware pipeline', async () => {
    const ch = makeChannel()
    const log: string[] = []
    ch.use((_, next) => { log.push('mw'); next() })
    ch.on('test:ping', () => {})
    ch.onAsync('test:ping', async () => {})

    ch.emit('test:ping', { value: 1 })
    await ch.emitAsync('test:ping', { value: 2 })

    expect(log).toEqual(['mw', 'mw'])
  })

  it('both emit() and emitAsync() forward to the debug wiretap', async () => {
    const onEmit = vi.fn()
    const ch = new Channel<TestContract>('test', '', STORM_CONFIG, onEmit)
    ch.on('test:ping', () => {})
    ch.onAsync('test:ping', async () => {})

    ch.emit('test:ping', { value: 1 })
    await ch.emitAsync('test:ping', { value: 2 })

    expect(onEmit).toHaveBeenCalledTimes(2)
  })

  it('destroy() stops delivery to all subscribers', async () => {
    const ch = makeChannel()
    const syncCb = vi.fn()
    const asyncCb = vi.fn().mockResolvedValue(undefined)
    ch.on('test:ping', syncCb)
    ch.onAsync('test:ping', asyncCb)
    ch.destroy()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ch.emit('test:ping', { value: 1 })
    await ch.emitAsync('test:ping', { value: 2 })

    expect(syncCb).not.toHaveBeenCalled()
    expect(asyncCb).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('debug message includes correct namespace and qualifiedChannel', async () => {
    const onEmit = vi.fn()
    const ch = new Channel<TestContract>('playback', 'vms', STORM_CONFIG, onEmit)
    ch.on('test:ping', () => {})
    ch.emit('test:ping', { value: 1 })

    const msg: DebugMessage = onEmit.mock.calls[0][0]
    expect(msg.namespace).toBe('vms')
    expect(msg.channel).toBe('playback')
    expect(msg.qualifiedChannel).toBe('vms:playback')
  })

  it('debug message has empty namespace and unqualified qualifiedChannel when no namespace', () => {
    const onEmit = vi.fn()
    const ch = new Channel<TestContract>('events', '', STORM_CONFIG, onEmit)
    ch.on('test:ping', () => {})
    ch.emit('test:ping', { value: 1 })

    const msg: DebugMessage = onEmit.mock.calls[0][0]
    expect(msg.namespace).toBe('')
    expect(msg.qualifiedChannel).toBe('events')
  })
})
