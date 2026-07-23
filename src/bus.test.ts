import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBus } from './bus'
import type { DebugMessage } from './types'

type PlaybackContract = {
  'playback:started': { cameraId: string }
  'playback:stopped': { cameraId: string }
}

type UIContract = {
  'ui:update': { label: string }
}

describe('Bus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the same channel instance on repeated calls with the same name', () => {
    const bus = createBus()
    const ch1 = bus.channel<PlaybackContract>('playback')
    const ch2 = bus.channel<PlaybackContract>('playback')
    expect(ch1).toBe(ch2)
    bus.destroy()
  })

  it('bus.channel("debug") throws', () => {
    const bus = createBus()
    expect(() => bus.channel('debug')).toThrow('[chbus]')
    bus.destroy()
  })

  it('bus.namespace() returns a NamespacedBus with the correct namespace', () => {
    const bus = createBus()
    const ns = bus.namespace('vms')
    expect(ns.namespace).toBe('vms')
    bus.destroy()
  })

  it('two NamespacedBus instances with the same namespace return the same underlying channel', () => {
    const bus = createBus()
    const ns1 = bus.namespace('vms')
    const ns2 = bus.namespace('vms')
    const ch1 = ns1.channel<PlaybackContract>('playback')
    const ch2 = ns2.channel<PlaybackContract>('playback')
    expect(ch1).toBe(ch2)
    bus.destroy()
  })

  it('two NamespacedBus instances with different namespaces return different channels for the same name', () => {
    const bus = createBus()
    const ns1 = bus.namespace('vms')
    const ns2 = bus.namespace('analytics')
    const ch1 = ns1.channel<PlaybackContract>('events')
    const ch2 = ns2.channel<PlaybackContract>('events')
    expect(ch1).not.toBe(ch2)
    bus.destroy()
  })

  it('bus.onDebug() receives a DebugMessage when a channel emits', () => {
    const bus = createBus()
    const messages: DebugMessage[] = []
    bus.onDebug((msg) => messages.push(msg))

    const ch = bus.channel<PlaybackContract>('playback')
    ch.on('playback:started', async () => {})
    ch.emit('playback:started', { cameraId: 'cam-1' }, { from: 'svc' })

    expect(messages).toHaveLength(1)
    bus.destroy()
  })

  it('DebugMessage contains correct namespace, channel, qualifiedChannel, action, payload, from', () => {
    const bus = createBus()
    const messages: DebugMessage[] = []
    bus.onDebug((msg) => messages.push(msg))

    const ns = bus.namespace('vms')
    const ch = ns.channel<PlaybackContract>('playback')
    ch.on('playback:started', async () => {})
    ch.emit('playback:started', { cameraId: 'cam-2' }, { from: 'playerCore' })

    const msg = messages[0]
    expect(msg.namespace).toBe('vms')
    expect(msg.channel).toBe('playback')
    expect(msg.qualifiedChannel).toBe('vms:playback')
    expect(msg.action).toBe('playback:started')
    expect(msg.payload).toEqual({ cameraId: 'cam-2' })
    expect(msg.from).toBe('playerCore')
    bus.destroy()
  })

  it('bus.destroy() destroys all channels', () => {
    const bus = createBus()
    const ch = bus.channel<PlaybackContract>('playback')
    const cb = vi.fn()
    ch.on('playback:started', cb)
    bus.destroy()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ch.emit('playback:started', { cameraId: 'x' })
    expect(cb).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('channels from different namespaces are isolated', () => {
    const bus = createBus()
    const ns1 = bus.namespace('vms')
    const ns2 = bus.namespace('analytics')

    const cb1 = vi.fn()
    const cb2 = vi.fn()

    ns1.channel<UIContract>('ui').on('ui:update', cb1)
    ns2.channel<UIContract>('ui').on('ui:update', cb2)

    ns1.channel<UIContract>('ui').emit('ui:update', { label: 'hello' })

    expect(cb1).toHaveBeenCalledOnce()
    expect(cb2).not.toHaveBeenCalled()
    bus.destroy()
  })

  describe('config conflict on existing channels', () => {
    it('optionless access to an existing channel succeeds', () => {
      const bus = createBus()
      const ch1 = bus.channel<UIContract>('ui', { storm: { maxMessages: 1000 } })
      const ch2 = bus.channel<UIContract>('ui')
      expect(ch2).toBe(ch1)
      bus.destroy()
    })

    it('re-access with options resolving to the same config succeeds', () => {
      const bus = createBus()
      const ch1 = bus.channel<UIContract>('ui', { storm: { maxMessages: 1000 } })
      const ch2 = bus.channel<UIContract>('ui', { storm: { maxMessages: 1000 } })
      expect(ch2).toBe(ch1)
      bus.destroy()
    })

    it('partial options resolving to the bus default succeed', () => {
      const bus = createBus()
      const ch1 = bus.channel<UIContract>('ui')
      // Bus default is maxMessages: 100 — this resolves to the existing config.
      const ch2 = bus.channel<UIContract>('ui', { storm: { maxMessages: 100 } })
      expect(ch2).toBe(ch1)
      bus.destroy()
    })

    it('access with a conflicting maxMessages throws', () => {
      const bus = createBus()
      bus.channel<UIContract>('ui')
      expect(() =>
        bus.channel<UIContract>('ui', { storm: { maxMessages: 1000 } }),
      ).toThrow(/already exists with storm config/)
      bus.destroy()
    })

    it('access with a conflicting windowMs throws', () => {
      const bus = createBus()
      bus.channel<UIContract>('ui', { storm: { windowMs: 500 } })
      expect(() =>
        bus.channel<UIContract>('ui', { storm: { windowMs: 2000 } }),
      ).toThrow(/already exists with storm config/)
      bus.destroy()
    })

    it('the error message includes both configs', () => {
      const bus = createBus()
      bus.channel<UIContract>('ui')
      expect(() =>
        bus.channel<UIContract>('ui', { storm: { maxMessages: 1000 } }),
      ).toThrow(/"maxMessages":100.*"maxMessages":1000/)
      bus.destroy()
    })

    it('namespaced channels throw on conflicting config too', () => {
      const bus = createBus()
      const ns = bus.namespace('vms')
      ns.channel<UIContract>('ui')
      expect(() =>
        ns.channel<UIContract>('ui', { storm: { maxMessages: 1000 } }),
      ).toThrow(/channel "vms:ui" already exists/)
      bus.destroy()
    })

    it('respects a non-default bus-level storm config when comparing', () => {
      const bus = createBus({ storm: { maxMessages: 1000 } })
      bus.channel<UIContract>('ui')
      // Resolves to { maxMessages: 1000, windowMs: 1000 } — same as existing.
      const ch = bus.channel<UIContract>('ui', { storm: { maxMessages: 1000 } })
      expect(ch).toBeDefined()
      bus.destroy()
    })
  })

  it('root Bus channel and namespaced channel with same name are independent', () => {
    const bus = createBus()
    const ns = bus.namespace('vms')

    const rootCb = vi.fn()
    const nsCb = vi.fn()

    bus.channel<PlaybackContract>('playback').on('playback:started', rootCb)
    ns.channel<PlaybackContract>('playback').on('playback:started', nsCb)

    bus.channel<PlaybackContract>('playback').emit('playback:started', { cameraId: 'x' })

    expect(rootCb).toHaveBeenCalledOnce()
    expect(nsCb).not.toHaveBeenCalled()
    bus.destroy()
  })
})
