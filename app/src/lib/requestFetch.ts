/** Preserve caller cancellation and the existing timeout through response body consumption. */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  options: RequestInit = {},
  timeoutMs = 5 * 60 * 1000,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const caller = options.signal;
  if (!caller) return fetch(input, { ...options, signal: timeout });
  if (typeof AbortSignal.any === 'function') {
    return fetch(input, { ...options, signal: AbortSignal.any([caller, timeout]) });
  }

  // Keep the former browser baseline (including Safari 16.4–17.3). Do not
  // remove these listeners merely because fetch resolved: that happens at
  // headers, while a streaming response body still needs cancellation.
  const controller = new AbortController();
  const cleanup = () => {
    caller.removeEventListener('abort', onCallerAbort);
    timeout.removeEventListener('abort', onTimeout);
  };
  const forward = (source: AbortSignal) => {
    cleanup();
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onCallerAbort = () => forward(caller);
  const onTimeout = () => forward(timeout);
  if (caller.aborted) forward(caller);
  else if (timeout.aborted) forward(timeout);
  else {
    caller.addEventListener('abort', onCallerAbort, { once: true });
    timeout.addEventListener('abort', onTimeout, { once: true });
    if (caller.aborted) onCallerAbort();
    else if (timeout.aborted) onTimeout();
  }
  try {
    return fetch(input, { ...options, signal: controller.signal }).then(response => {
      // Preserve the native Response/stream. A successful body-bearing response
      // keeps the two listeners until cancellation or the original timeout;
      // this bound avoids buffering/cloning/wrapping streaming bodies just to
      // observe completion. A bodyless response has no remaining work to guard.
      if (!response.body) cleanup();
      return response;
    }, error => {
      cleanup();
      throw error;
    });
  } catch (error) {
    cleanup();
    throw error;
  }
}
