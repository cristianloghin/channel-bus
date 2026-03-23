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
// Chain tracing: each message records its own coordination ID in an internal
// registry. When a downstream message arrives its ancestor IDs are resolved to
// human-readable "[channel] action" labels, giving a full flow trace instead
// of raw UUIDs.  The registry is bounded to 500 entries (oldest evicted first).
//
const CHAIN_REGISTRY_MAX = 500

type ChainEntry = { action: string; qualifiedChannel: string }

export function createLogger(bus: Bus, options?: LoggerOptions): () => void {
  let lastTimestamp: number | null = null
  const chainRegistry = new Map<string, ChainEntry>()

  return bus.onDebug((msg: DebugMessage) => {
    if (!passes(msg, options?.filter)) return

    // Register this emission so descendants can resolve it by coordination ID.
    const ownCoordId = msg.coordinationChain.at(-1)
    if (ownCoordId) {
      if (chainRegistry.size >= CHAIN_REGISTRY_MAX) {
        // Keep memory bounded — drop the oldest entry.
        const oldestKey = chainRegistry.keys().next().value
        if (oldestKey !== undefined) chainRegistry.delete(oldestKey)
      }
      chainRegistry.set(ownCoordId, {
        action: msg.action,
        qualifiedChannel: msg.qualifiedChannel,
      })
    }

    // Build a human-readable flow trace from ancestor coordination IDs.
    const ancestors = msg.coordinationChain.slice(0, -1)
    const chain =
      ancestors.length === 0
        ? '(root)'
        : ancestors
            .map((id) => {
              const entry = chainRegistry.get(id)
              return entry
                ? `[${entry.qualifiedChannel}] ${entry.action}`
                : `<${id.slice(0, 8)}>`
            })
            .join(' → ')

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
    console.log('chain:   ', chain)
    console.log('id:      ', msg.messageId)
    console.groupEnd()
  })
}

function passes(
  msg: DebugMessage,
  filter?: LoggerOptions['filter'],
): boolean {
  if (!filter) return true

  // Include-lists — each non-empty list must contain the message's value.
  if (filter.namespaces && filter.namespaces.length > 0) {
    if (!filter.namespaces.includes(msg.namespace)) return false
  }

  if (filter.channels && filter.channels.length > 0) {
    if (!filter.channels.includes(msg.channel)) return false
  }

  if (filter.actions && filter.actions.length > 0) {
    if (!filter.actions.includes(msg.action)) return false
  }

  // Exclude-lists — any match blocks the message.
  if (filter.exclude) {
    const { exclude } = filter

    if (exclude.namespaces && exclude.namespaces.includes(msg.namespace)) return false
    if (exclude.channels && exclude.channels.includes(msg.channel)) return false
    if (exclude.actions && exclude.actions.includes(msg.action)) return false
  }

  // Predicate — final gate for arbitrary logic.
  if (filter.predicate && !filter.predicate(msg.action, msg.payload, msg)) {
    return false
  }

  return true
}
