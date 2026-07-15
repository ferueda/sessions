const SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;
const REFRESH_INTERVAL_MS = 1_000;

export interface CliActivityOutput {
  readonly stderrIsInteractive?: boolean;
  writeErr(text: string): void;
  clearErrLine?(): void;
}

/** Show transient terminal activity without affecting the wrapped operation. */
export async function withCliActivity<T>(
  output: CliActivityOutput,
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (output.stderrIsInteractive !== true || output.clearErrLine === undefined) {
    return operation();
  }

  const startedAt = Date.now();
  let frame = 0;
  let enabled = true;
  let timer: ReturnType<typeof setInterval> | undefined;

  const disable = () => {
    enabled = false;
    if (timer !== undefined) clearInterval(timer);
  };
  const render = () => {
    if (!enabled) return;
    try {
      output.clearErrLine?.();
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
      output.writeErr(
        `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${label} (${String(elapsedSeconds)}s)`,
      );
      frame += 1;
    } catch {
      // Terminal feedback is best-effort and must not change command behavior.
      disable();
    }
  };

  render();
  if (enabled) timer = setInterval(render, REFRESH_INTERVAL_MS);

  try {
    return await operation();
  } finally {
    disable();
    try {
      output.clearErrLine();
    } catch {
      // Preserve the operation result when terminal cleanup is unavailable.
    }
  }
}
