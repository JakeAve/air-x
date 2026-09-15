export function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

/** Resolves when the signal aborts. */
export function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** `AbortSignal.any`, which Safari lacks before 17.4. */
export function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  if (signals.some((s) => s.aborted)) {
    controller.abort();
    return controller.signal;
  }
  const onAbort = () => {
    for (const s of signals) s.removeEventListener("abort", onAbort);
    controller.abort();
  };
  for (const s of signals) s.addEventListener("abort", onAbort);
  return controller.signal;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
