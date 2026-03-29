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
