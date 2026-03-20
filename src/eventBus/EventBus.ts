export type EventEmitter = {
  className: string;
  methodName: string;
  timestamp: number;
};

export type EventCallback<T> = (
  payload: T,
  emitter?: EventEmitter,
) => void | Promise<void>;

export type EventSubscriber = {
  className: string;
  methodName: string;
};

export interface EventBusSubscription {
  unsubscribe: () => void;
}

export class EventBus<TEventMap> {
  private listeners = new Map<
    keyof TEventMap,
    Map<EventSubscriber, Set<EventCallback<any>>>
  >();

  constructor(private debug = false) {}

  emit<K extends keyof TEventMap>(
    event: K,
    payload: TEventMap[K],
    emitter?: EventEmitter,
  ): void {
    const subscribers = this.listeners.get(event);
    if (!subscribers) return;

    if (this.debug) this.log(event, payload, emitter);

    subscribers.forEach((callbacksForSubscriber, subscriber) => {
      callbacksForSubscriber.forEach((cb) => {
        try {
          cb(payload, emitter);
        } catch (error) {
          console.error(
            `Error in event handler for ${String(event)} (subscriber ${subscriber.className}.${subscriber.methodName}):`,
            error,
          );
        }
      });
    });
  }

  async emitAsync<K extends keyof TEventMap>(
    event: K,
    payload: TEventMap[K],
    emitter?: EventEmitter,
  ): Promise<void> {
    const subscribers = this.listeners.get(event);
    if (!subscribers) return;

    if (this.debug) this.log(event, payload, emitter);

    const promises: Promise<void>[] = [];

    subscribers.forEach((callbacksForSubscriber, subscriber) => {
      callbacksForSubscriber.forEach((cb) => {
        try {
          const result = cb(payload, emitter);
          if (result instanceof Promise) {
            promises.push(
              Promise.resolve(result).catch((error) => {
                console.error(
                  `Error in async event handler for ${String(event)} (subscriber ${subscriber.className}.${subscriber.methodName}):`,
                  error,
                );
                throw error;
              }),
            );
          }
        } catch (error) {
          console.error(
            `Error in event handler for ${String(event)} (subscriber ${subscriber.className}.${subscriber.methodName}):`,
            error,
          );
        }
      });
    });

    await Promise.all(promises);
  }

  on<K extends keyof TEventMap>(
    event: K,
    callback: EventCallback<TEventMap[K]>,
    options?: {
      signal?: AbortSignal;
      subscriber?: EventSubscriber;
    },
  ): EventBusSubscription {
    if (options?.signal?.aborted) {
      return { unsubscribe: () => {} };
    }

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Map());
    }

    const subscribers = this.listeners.get(event)!;
    const subscriber: EventSubscriber =
      options?.subscriber ??
      ({ className: "Unknown", methodName: "anonymous" } as const);

    let callbacksForSubscriber = subscribers.get(subscriber);
    if (!callbacksForSubscriber) {
      callbacksForSubscriber = new Set();
      subscribers.set(subscriber, callbacksForSubscriber);
    }

    callbacksForSubscriber.add(callback);

    const subscription: EventBusSubscription = {
      unsubscribe: () => {
        const currentSubscribers = this.listeners.get(event);
        if (!currentSubscribers) return;

        const currentCallbacks = currentSubscribers.get(subscriber);
        if (!currentCallbacks) return;

        currentCallbacks.delete(callback);

        if (currentCallbacks.size === 0) {
          currentSubscribers.delete(subscriber);
        }

        if (currentSubscribers.size === 0) {
          this.listeners.delete(event);
        }
      },
    };

    if (options?.signal) {
      options.signal.addEventListener("abort", () => subscription.unsubscribe(), {
        once: true,
      });
    }

    return subscription;
  }

  clear() {
    this.listeners.clear();
  }

  private log<K extends keyof TEventMap>(
    event: K,
    payload: TEventMap[K],
    emitter?: EventEmitter,
  ) {
    const subscribers = this.listeners.get(event);
    if (!subscribers) return;

    let callbackCount = 0;
    const subscriberArray: string[] = [];
    subscribers.forEach((callbacksForSubscriber, s) => {
      callbackCount += callbacksForSubscriber.size;
      subscriberArray.push(`${s.className}.${s.methodName}`);
    });

    if (emitter) {
      console.debug(
        `[${emitter.timestamp} ${String(event)}] ${emitter.className}.${emitter.methodName} subscribers: ${subscribers.size}, callbacks: ${callbackCount}.`,
        subscriberArray,
        payload,
      );
    }
  }
}
