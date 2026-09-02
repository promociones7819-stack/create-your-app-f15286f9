export type SyncState = "pending" | "syncing" | "synced" | "error";

/** Coalesces edits, never overlaps writes, and retries without dropping newer work. */
export function createSyncQueue(
  publish: () => Promise<void>,
  report: (state: SyncState, error?: string) => void,
  delay = 500,
  retryDelay = 5_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let dirty = false;
  let disposed = false;
  let failures = 0;
  function later(ms: number) {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), ms);
  }
  async function flush() {
    if (disposed || running || !dirty) return;
    running = true;
    dirty = false;
    report("syncing");
    try {
      await publish();
      failures = 0;
      if (!disposed) report(dirty ? "pending" : "synced");
    } catch (error) {
      dirty = true;
      failures += 1;
      if (!disposed)
        report(
          "error",
          error instanceof Error ? error.message : "No se pudo conectar con el catálogo.",
        );
    } finally {
      running = false;
      if (!disposed && dirty)
        later(failures ? Math.min(60_000, retryDelay * 2 ** (failures - 1)) : delay);
    }
  }
  return {
    schedule(immediate = false) {
      if (disposed) return;
      dirty = true;
      if (!running) {
        report("pending");
        later(immediate ? 0 : delay);
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
