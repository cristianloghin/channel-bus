import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBus } from './bus'
import { createLogger } from './logger'

type TestContract = {
  'test:event': { value: number }
}

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls console.groupCollapsed by default when a message is emitted', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus)
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(gc).toHaveBeenCalled()
    stop()
    bus.destroy()
  })

  it('calls console.group when collapsed is false', () => {
    const g = vi.spyOn(console, 'group').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, { collapsed: false })
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(g).toHaveBeenCalled()
    stop()
    bus.destroy()
  })

  it('filtered messages produce no console output', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, { filter: { namespaces: ['other'] } })
    const ns = bus.namespace('vms')
    const ch = ns.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(gc).not.toHaveBeenCalled()
    stop()
    bus.destroy()
  })

  it('namespace filter allows matching messages through', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, { filter: { namespaces: ['vms'] } })
    const ns = bus.namespace('vms')
    const ch = ns.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(gc).toHaveBeenCalled()
    stop()
    bus.destroy()
  })

  it('channel filter allows only matching channel names', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, { filter: { channels: ['playback'] } })

    const ch1 = bus.channel<TestContract>('playback')
    const ch2 = bus.channel<TestContract>('ui')
    ch1.on('test:event', () => {})
    ch2.on('test:event', () => {})
    ch1.emit('test:event', { value: 1 })
    ch2.emit('test:event', { value: 2 })

    expect(gc).toHaveBeenCalledTimes(1)
    stop()
    bus.destroy()
  })

  it('action filter allows only matching actions', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, { filter: { actions: ['test:event'] } })
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(gc).toHaveBeenCalledTimes(1)
    stop()
    bus.destroy()
  })

  it('the stop function unsubscribes from the debug wiretap', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus)
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})

    stop() // unsubscribe before emitting

    ch.emit('test:event', { value: 1 })
    expect(gc).not.toHaveBeenCalled()
    bus.destroy()
  })

  it('after stopping, no further console output is produced', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus)
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})

    ch.emit('test:event', { value: 1 })
    expect(gc).toHaveBeenCalledTimes(1)

    stop()
    ch.emit('test:event', { value: 2 })
    expect(gc).toHaveBeenCalledTimes(1) // no second call
    bus.destroy()
  })
})
