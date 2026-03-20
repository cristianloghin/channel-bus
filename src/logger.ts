import type { Bus } from './bus'
import type { DebugMessage, LoggerOptions } from './types'

// A zero-dependency console devtool. Subscribes to the Bus debug wiretap and
// pretty-prints every message using console.group / console.groupCollapsed.
// Returns an unsubscribe function — call it to stop logging.
//
// Usage:
//   const stop = createLogger(bus)
//   const stop = createLogger(bus, { collapsed: false, filter: { namespaces: ['vms'] } })
//   stop()
//
export function createLogger(bus: Bus, options?: LoggerOptions): () => void {
  let lastTimestamp: number | null = null

  return bus.onDebug((msg: DebugMessage) => {
    if (!passes(msg, options?.filter)) return

    const now = msg.timestamp
    const delta = lastTimestamp !== null ? `+${now - lastTimestamp}ms` : '+0ms'
    lastTimestamp = now

    const label = `[${msg.qualifiedChannel}] ${msg.action}  ${delta}`
    const groupFn =
      options?.collapsed !== false ? console.groupCollapsed : console.group

    groupFn(label)
    console.log('action:  ', msg.action)
    console.log('payload: ', msg.payload)
    console.log('from:    ', msg.from)
    console.log('chain:   ', msg.coordinationChain)
    console.log('id:      ', msg.messageId)
    console.groupEnd()
  })
}

function passes(
  msg: DebugMessage,
  filter?: LoggerOptions['filter'],
): boolean {
  if (!filter) return true

  if (filter.namespaces && filter.namespaces.length > 0) {
    if (!filter.namespaces.includes(msg.namespace)) return false
  }

  if (filter.channels && filter.channels.length > 0) {
    if (!filter.channels.includes(msg.channel)) return false
  }

  if (filter.actions && filter.actions.length > 0) {
    if (!filter.actions.includes(msg.action)) return false
  }

  return true
}
