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
