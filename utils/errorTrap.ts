// Global JS error trap — installed as the very first import in the root layout.
//
// In a release build, an uncaught error at launch goes through React Native's
// error pipeline and hard-crashes the app (RCTFatal) with no visible message.
// This installs a global handler *before* the rest of the app loads, captures
// the error, and exposes it so the UI can render it on screen instead of
// crashing. Diagnostic aid — harmless to keep (it only surfaces if something
// actually throws).

let trapped: string | null = null;
const listeners = new Set<(message: string) => void>();

export function getTrappedError(): string | null {
  return trapped;
}

export function subscribeTrappedError(cb: (message: string) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EU = (globalThis as { ErrorUtils?: {
  getGlobalHandler?: () => (e: unknown, isFatal?: boolean) => void;
  setGlobalHandler?: (h: (e: unknown, isFatal?: boolean) => void) => void;
} }).ErrorUtils;

if (EU?.setGlobalHandler) {
  const previous = EU.getGlobalHandler?.();
  EU.setGlobalHandler((e: unknown, isFatal?: boolean) => {
    try {
      const err = e as { name?: string; message?: string; stack?: string } | undefined;
      trapped = `${err?.name ?? 'Error'}: ${err?.message ?? String(e)}\n\n${err?.stack ?? ''}`;
      listeners.forEach(l => l(trapped as string));
    } catch {
      // never let the trap itself throw
    }
    // In dev, still hand off to the default handler so the redbox shows as usual.
    // In release we intentionally swallow it so our on-screen message can render
    // instead of the app aborting.
    if (__DEV__ && previous) previous(e, isFatal);
  });
}
