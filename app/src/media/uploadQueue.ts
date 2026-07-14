// Generic, crypto-agnostic bounded-concurrency retry queue for chat
// attachment uploads. Deliberately knows nothing about MessageRow, S3, or
// encryption — ChatScreen supplies the actual upload+send work as a plain
// async closure (see uploadThenSend) plus a failure classifier and a
// give-up callback for updating DB/UI state once retries are exhausted.
// Keeping this generic means the send/encrypt pipeline (sendPayload/
// uploadThenSend) is never touched — only how many run at once and whether
// a failed one gets tried again is orchestrated here.

// Two uploads at a time is enough to keep a multi-photo batch from
// saturating the connection while still overlapping some latency.
const MAX_CONCURRENT_UPLOADS = 2;
// One initial attempt (handled by the caller before ever reaching here) plus
// these backoff delays — after the last one is exhausted, the task is
// given up on and the caller's onGiveUp marks it for manual retry.
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

interface QueuedTask {
  id: string;
  run: () => Promise<void>;
  isPermanentFailure: (err: unknown) => boolean;
  onGiveUp?: (err: unknown) => void;
  attempt: number;
}

const pending: QueuedTask[] = [];
// Tracks every id currently queued OR in flight, so a fresh send, a manual
// retry tap, and the resume-on-reopen sweep can never double-enqueue the
// same message.
const queuedIds = new Set<string>();
// A task waiting out its backoff delay is in neither `pending` nor active —
// it only exists as this scheduled callback. Tracked so cancelQueuedUpload
// can actually stop it; without this a cancel during the backoff window was
// a no-op (the retry still fired later) and desynced queuedIds, letting a
// second enqueue for the same id race the still-alive retry.
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let activeCount = 0;

export interface EnqueueUploadOptions {
  /** Errors matching this are never retried — e.g. file too large, uploads unavailable. Default: always retry. */
  isPermanentFailure?: (err: unknown) => boolean;
  /** Called once, only when the task is finally abandoned (permanent failure, or retries exhausted) — the caller's chance to mark it failed in the DB/UI. */
  onGiveUp?: (err: unknown) => void;
}

export function enqueueUpload(id: string, run: () => Promise<void>, options: EnqueueUploadOptions = {}): void {
  if (queuedIds.has(id)) return;
  queuedIds.add(id);
  pending.push({ id, run, isPermanentFailure: options.isPermanentFailure ?? (() => false), onGiveUp: options.onGiveUp, attempt: 0 });
  processQueue();
}

/** Removes a not-yet-started task — still in `pending`, or waiting out a retry backoff (e.g. the user cancelled the send). A task already in flight can't be aborted mid-request — its own completion handler is expected to no-op if the message no longer exists. */
export function cancelQueuedUpload(id: string): void {
  const index = pending.findIndex((task) => task.id === id);
  if (index !== -1) pending.splice(index, 1);
  const timer = retryTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(id);
  }
  queuedIds.delete(id);
}

function processQueue(): void {
  while (activeCount < MAX_CONCURRENT_UPLOADS && pending.length > 0) {
    const task = pending.shift()!;
    activeCount++;
    void runTask(task);
  }
}

async function runTask(task: QueuedTask): Promise<void> {
  try {
    await task.run();
    queuedIds.delete(task.id);
  } catch (err) {
    const permanent = task.isPermanentFailure(err);
    const exhausted = task.attempt >= RETRY_DELAYS_MS.length;
    if (permanent || exhausted) {
      queuedIds.delete(task.id);
      console.warn(`[uploadQueue] giving up on ${task.id} after ${task.attempt + 1} attempt(s)`, err);
      task.onGiveUp?.(err);
    } else {
      const delay = RETRY_DELAYS_MS[task.attempt];
      task.attempt += 1;
      console.warn(`[uploadQueue] retrying ${task.id} in ${delay}ms (attempt ${task.attempt})`, err);
      const timer = setTimeout(() => {
        retryTimers.delete(task.id);
        pending.push(task);
        processQueue();
      }, delay);
      retryTimers.set(task.id, timer);
    }
  } finally {
    activeCount -= 1;
    processQueue();
  }
}
