/**
 * Lets Telegram / CLI invoke the same teardown as SIGINT without relying on
 * synthetic signals (unreliable under tsx watch on Windows).
 */

let impl: (() => void) | null = null;

export function registerGracefulShutdown(fn: () => void): void {
  impl = fn;
}

/** Runs DB save, stops frontend, releases lock, and process.exit(0). */
export function requestGracefulShutdown(): void {
  if (impl) impl();
  else {
    console.warn("P2 Claw: graceful shutdown not registered; forcing exit.");
    process.exit(0);
  }
}
