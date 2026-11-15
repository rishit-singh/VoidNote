// Browser resources live outside React: changing routes never closes the microphone.
export const captureSupported = () =>
  typeof window !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== "undefined" &&
  !!navigator.locks;

// Fail closed without Web Locks rather than pretending cross-tab exclusion is safe.
// The origin-wide lock covers permission prompts, capture, and draining storage writes.
const liveLeases = new WeakSet<() => void>();
export async function acquireCaptureLock(): Promise<() => void> {
  if (!navigator.locks)
    throw new Error(
      "Local audio needs a browser with Web Locks support. Open VoidNote in a current browser over HTTPS.",
    );
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request("voidnote-microphone", { ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(new Error("Another tab is capturing audio. Stop it there first."));
          return;
        }
        await new Promise<void>((release) => {
          const lease = () => {
            liveLeases.delete(lease);
            release();
          };
          liveLeases.add(lease);
          resolve(lease);
        });
      })
      .catch(reject);
  });
}

// Only the actual lock holder can finalize without reacquiring its own lock.
// A session ID or this tab's activeSessionId is not proof of lock ownership.
export async function withCaptureLock<T>(action: () => Promise<T>, lease?: () => void): Promise<T> {
  if (lease && liveLeases.has(lease)) return action();
  const release = await acquireCaptureLock();
  try {
    return await action();
  } finally {
    release();
  }
}
