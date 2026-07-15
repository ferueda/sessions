import { setImmediate } from "node:timers/promises";

/** Let timers and other queued event-loop work run between synchronous work units. */
export async function yieldToEventLoop(): Promise<void> {
  await setImmediate();
}
