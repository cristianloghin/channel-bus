// A contract maps action names to payload types.
// e.g. { 'playback:start': { cameraId: string }, 'playback:stop': void }
export type ChannelContract = Record<string, unknown>

// A fully-typed message flowing through a channel.
export interface Message<C extends ChannelContract, A extends keyof C = keyof C> {
  id: string               // unique message ID (crypto.randomUUID)
  namespace: string        // namespace this channel belongs to ('' if none)
  channel: string          // unqualified channel name
  action: A                // action name
  payload: C[A]            // typed payload
  from: string             // sender ID
  coordinationChain: string[]  // for loop detection
  timestamp: number        // Date.now()
}

// A flattened copy of every message forwarded to the debug wiretap.
export interface DebugMessage {
  namespace: string        // namespace of the originating channel ('' if none)
  channel: string          // unqualified channel name
  qualifiedChannel: string // 'namespace:channel', or just 'channel' if no namespace
  action: string
  payload: unknown
  from: string
  coordinationChain: string[]
  timestamp: number
  messageId: string
}

export type Next = () => void

export type Middleware<C extends ChannelContract> = (
  message: Message<C>,
  next: Next,
) => void

// Synchronous subscriber — registered with on(), called by emit().
export type Subscriber<C extends ChannelContract, A extends keyof C> = (
  payload: C[A],
  meta: { message: Message<C, A> },
) => void

// Asynchronous subscriber — registered with onAsync(), called by emitAsync().
export type AsyncSubscriber<C extends ChannelContract, A extends keyof C> = (
  payload: C[A],
  meta: { message: Message<C, A> },
) => Promise<void>

// Outcome of a single async subscriber execution returned by emitAsync().
export interface SettledResult {
  status: 'fulfilled' | 'rejected'
  reason?: unknown  // present if status is 'rejected'
}

export interface StormConfig {
  maxMessages: number  // default: 100
  windowMs: number     // default: 1000
}

export interface BusConfig {
  storm?: Partial<StormConfig>
}

// Optional per-channel overrides passed as the second argument to channel().
export interface ChannelOptions {
  storm?: Partial<StormConfig>
}

export interface EmitOptions {
  from?: string                  // sender ID, defaults to 'anonymous'
  coordinationChain?: string[]   // chain from upstream message, for loop detection
}

export interface LoggerOptions {
  collapsed?: boolean  // default: true — use groupCollapsed instead of group
  filter?: {
    namespaces?: string[]  // only log messages from these namespaces
    channels?: string[]    // only log messages from these unqualified channel names
    actions?: string[]     // only log messages matching these action names
  }
}
