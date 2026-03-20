import { uuidv4 } from "../utils/uuid";
import {
  EventBus,
  EventBusSubscription,
  EventCallback,
} from "./EventBus";

export class WithEventBus<TEventMap> {
  _eventBus: EventBus<TEventMap>;
  _uuid: string;
  private className: string;

  constructor(className: string, eventBus: EventBus<TEventMap>) {
    this._eventBus = eventBus;
    this.className = className;
    this._uuid = uuidv4();
  }

  emit = <K extends keyof TEventMap>(
    event: K,
    payload: TEventMap[K],
    methodName?: string,
  ): void => {
    if (!methodName) {
      this._eventBus.emit(event, payload);
    } else {
      this._eventBus.emit(event, payload, {
        className: this.className,
        methodName,
        timestamp: Number(performance.now().toFixed(2)),
      });
    }
  };

  emitAsync = async <K extends keyof TEventMap>(
    event: K,
    payload: TEventMap[K],
    methodName?: string,
  ): Promise<void> => {
    if (!methodName) {
      await this._eventBus.emitAsync(event, payload);
    } else {
      await this._eventBus.emitAsync(event, payload, {
        className: this.className,
        methodName,
        timestamp: Number(performance.now().toFixed(2)),
      });
    }
  };

  on = <K extends keyof TEventMap>(
    event: K,
    callback: EventCallback<TEventMap[K]>,
    signal?: AbortSignal,
    methodName?: string,
  ): EventBusSubscription => {
    const options = {
      signal,
      subscriber: methodName
        ? { className: this.className, methodName }
        : undefined,
    };
    return this._eventBus.on(event, callback, options);
  };
}
