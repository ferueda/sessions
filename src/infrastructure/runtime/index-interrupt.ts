export type IndexProcessSignal = "SIGINT" | "SIGTERM";
export type IndexSignalExitCode = 130 | 143;

export interface ProcessSignalSource {
  once(signal: IndexProcessSignal, listener: () => void): unknown;
  off(signal: IndexProcessSignal, listener: () => void): unknown;
}

export interface IndexInterruption {
  readonly signal: IndexProcessSignal;
  readonly exitCode: IndexSignalExitCode;
}

export interface IndexInterruptController {
  readonly signal: AbortSignal;
  readonly interruption: IndexInterruption | undefined;
  dispose(): void;
}

/** Convert the first process signal into cooperative indexing cancellation. */
export function installIndexInterrupt(
  source: ProcessSignalSource = process,
): IndexInterruptController {
  const controller = new AbortController();
  let interruption: IndexInterruption | undefined;
  let listening = true;

  const stopListening = (): void => {
    if (!listening) return;
    listening = false;
    source.off("SIGINT", onInterrupt);
    source.off("SIGTERM", onTerminate);
  };
  const interrupt = (signal: IndexProcessSignal): void => {
    if (interruption !== undefined) return;
    interruption = Object.freeze({ signal, exitCode: signal === "SIGINT" ? 130 : 143 });
    // Removing both handlers restores force-termination behavior for a later signal.
    stopListening();
    controller.abort();
  };
  const onInterrupt = (): void => interrupt("SIGINT");
  const onTerminate = (): void => interrupt("SIGTERM");

  source.once("SIGINT", onInterrupt);
  source.once("SIGTERM", onTerminate);

  return {
    signal: controller.signal,
    get interruption() {
      return interruption;
    },
    dispose: stopListening,
  };
}
