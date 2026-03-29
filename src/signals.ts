// A signal that never aborts — used as the default when no signal is provided.
// Exported so consumers can detect it and avoid adding permanent listeners.
const _inertController = new AbortController()
export const INERT_SIGNAL: AbortSignal = _inertController.signal

export function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  const controller = new AbortController();

  // If any signal is already aborted, abort immediately
  if (signals.some((s) => s?.aborted)) {
    controller.abort();
    return controller.signal;
  }

  // Listen to all signals and abort when any fires
  const onAbort = () => controller.abort();
  signals.forEach((signal) => {
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });

  return controller.signal;
}
