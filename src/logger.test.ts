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

  it('root message shows "(root)" as its chain', () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})
    const chainValues: unknown[] = []
    vi.spyOn(console, 'log').mockImplementation((label: unknown, value?: unknown) => {
      if (label === 'chain:   ') chainValues.push(value)
    })

    const bus = createBus()
    const stop = createLogger(bus)
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(chainValues).toHaveLength(1)
    expect(chainValues[0]).toBe('(root)')
    stop()
    bus.destroy()
  })

  it('triggered message resolves ancestor labels into a readable flow', () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})
    const chainValues: unknown[] = []
    vi.spyOn(console, 'log').mockImplementation((label: unknown, value?: unknown) => {
      if (label === 'chain:   ') chainValues.push(value)
    })

    const bus = createBus()
    const stop = createLogger(bus)
    const chA = bus.channel<TestContract>('channelA')
    const chB = bus.channel<TestContract>('channelB')

    // When channelA fires, its subscriber forwards the coordination chain to channelB.
    chA.on('test:event', (_, { message }) => {
      chB.emit('test:event', { value: 2 }, { coordinationChain: message.coordinationChain })
    })
    chB.on('test:event', () => {})
    chA.emit('test:event', { value: 1 })

    // channelA is the root; channelB was triggered by it.
    expect(chainValues).toHaveLength(2)
    expect(chainValues[0]).toBe('(root)')
    expect(chainValues[1]).toBe('[channelA] test:event')
    stop()
    bus.destroy()
  })

  it('three-level chain shows the full readable flow', () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})
    const chainValues: unknown[] = []
    vi.spyOn(console, 'log').mockImplementation((label: unknown, value?: unknown) => {
      if (label === 'chain:   ') chainValues.push(value)
    })

    const bus = createBus()
    const stop = createLogger(bus)
    const chA = bus.channel<TestContract>('chA')
    const chB = bus.channel<TestContract>('chB')
    const chC = bus.channel<TestContract>('chC')

    chA.on('test:event', (_, { message }) => {
      chB.emit('test:event', { value: 2 }, { coordinationChain: message.coordinationChain })
    })
    chB.on('test:event', (_, { message }) => {
      chC.emit('test:event', { value: 3 }, { coordinationChain: message.coordinationChain })
    })
    chC.on('test:event', () => {})
    chA.emit('test:event', { value: 1 })

    expect(chainValues).toHaveLength(3)
    expect(chainValues[0]).toBe('(root)')
    expect(chainValues[1]).toBe('[chA] test:event')
    expect(chainValues[2]).toBe('[chA] test:event → [chB] test:event')
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

  it('exclude.namespace blocks messages from that namespace', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, { filter: { exclude: { namespaces: ['vms'] } } })
    const ns = bus.namespace('vms')
    const ch = ns.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(gc).not.toHaveBeenCalled()
    stop()
    bus.destroy()
  })

  it('exclude.channels blocks messages from that channel', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, { filter: { exclude: { channels: ['noisy'] } } })

    const ch1 = bus.channel<TestContract>('noisy')
    const ch2 = bus.channel<TestContract>('test')
    ch1.on('test:event', () => {})
    ch2.on('test:event', () => {})
    ch1.emit('test:event', { value: 1 })
    ch2.emit('test:event', { value: 2 })

    expect(gc).toHaveBeenCalledTimes(1)
    stop()
    bus.destroy()
  })

  it('exclude.actions blocks messages with that action', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, { filter: { exclude: { actions: ['test:event'] } } })
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(gc).not.toHaveBeenCalled()
    stop()
    bus.destroy()
  })

  it('predicate returning false suppresses the message', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, {
      filter: { predicate: (_action, payload) => (payload as { value: number }).value !== 42 },
    })
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 42 })

    expect(gc).not.toHaveBeenCalled()
    stop()
    bus.destroy()
  })

  it('predicate returning true allows the message through', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const stop = createLogger(bus, {
      filter: { predicate: (_action, payload) => (payload as { value: number }).value !== 42 },
    })
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(gc).toHaveBeenCalledTimes(1)
    stop()
    bus.destroy()
  })

  it('predicate receives action, payload, and full DebugMessage meta', () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    const predicate = vi.fn().mockReturnValue(true)
    const stop = createLogger(bus, { filter: { predicate } })
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 7 })

    expect(predicate).toHaveBeenCalledOnce()
    const [action, payload, meta] = predicate.mock.calls[0]
    expect(action).toBe('test:event')
    expect(payload).toEqual({ value: 7 })
    expect(meta).toMatchObject({ action: 'test:event', channel: 'test', payload: { value: 7 } })
    stop()
    bus.destroy()
  })

  it('include-list and exclude-list compose correctly', () => {
    const gc = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {})

    const bus = createBus()
    // Include only 'test' channel, but exclude the 'test:event' action within it.
    const stop = createLogger(bus, {
      filter: { channels: ['test'], exclude: { actions: ['test:event'] } },
    })
    const ch = bus.channel<TestContract>('test')
    ch.on('test:event', () => {})
    ch.emit('test:event', { value: 1 })

    expect(gc).not.toHaveBeenCalled()
    stop()
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
