/** The slice of `bb.storage.kv` this plugin uses, and the timeout every call runs under. */
export type KvLike = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
};

/**
 * How long any one kv call may take before the caller gives up and answers "no record".
 *
 * The dispatch hook is on bb's critical path and an SDK hook that exceeds 10s fails the
 * attempt, so a wedged kv is the one way this observe-only code could still affect a
 * dispatch. Every storage read the hook makes is bounded by this.
 */
export const KV_TIMEOUT_MS = 1_000;

export const TIMED_OUT = Symbol("kv-timeout");

/** Resolve `work` or, after `ms`, the `TIMED_OUT` sentinel. Never leaves a timer armed. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
