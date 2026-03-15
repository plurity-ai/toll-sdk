import type { TrackingEvent, TollBackend } from "./types.js";

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_BUFFER_SIZE = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Buffers tracking events and flushes them in batches.
 * - Flushes on interval OR when batch size threshold is reached.
 * - On failure: keeps events, exponential backoff.
 * - Hard cap on buffer size: evicts oldest when full.
 */
export class EventBatcher {
  private buffer: TrackingEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 10_000;
  private readonly backend: TollBackend;
  private readonly siteId: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxBufferSize: number;
  private readonly onError?: (error: Error) => void;
  private readonly onFlush?: (count: number) => void;

  constructor(options: {
    backend: TollBackend;
    siteId: string;
    flushIntervalMs?: number;
    maxBatchSize?: number;
    maxBufferSize?: number;
    onError?: (error: Error) => void;
    onFlush?: (count: number) => void;
  }) {
    this.backend = options.backend;
    this.siteId = options.siteId;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.onError = options.onError;
    this.onFlush = options.onFlush;

    this.startTimer();

    // Flush on process exit (Node.js only — Edge Runtime doesn't support process.on)
    if (typeof process !== "undefined" && typeof process.on === "function") {
      process.on("beforeExit", () => {
        this.flush().catch(() => {});
      });
    }
  }

  add(event: TrackingEvent): void {
    if (this.buffer.length >= this.maxBufferSize) {
      // Evict oldest
      this.buffer.shift();
    }
    this.buffer.push(event);

    if (this.buffer.length >= this.maxBatchSize) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.maxBatchSize);

    try {
      await this.backend.sendEvents(this.siteId, batch);
      this.backoffMs = 10_000; // reset backoff on success
      this.onFlush?.(batch.length);
    } catch (err) {
      // Put events back at front of buffer
      this.buffer.unshift(...batch);

      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);

      // Exponential backoff
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this.restartTimerWithBackoff();
    }
  }

  async shutdown(): Promise<void> {
    this.stopTimer();
    // One final flush with 5s timeout
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      this.flush().catch(() => {});
    }, this.flushIntervalMs);

    // Don't keep the process alive just for this timer (Node.js only)
    if (this.timer && typeof (this.timer as unknown as { unref?: () => void }).unref === "function") {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private restartTimerWithBackoff(): void {
    this.stopTimer();
    setTimeout(() => {
      this.startTimer();
    }, this.backoffMs);
  }
}
