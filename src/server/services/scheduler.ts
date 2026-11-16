import type { TaggingMode } from '../config.js';
import { formatCycle, type CycleResult, type Pipeline } from './pipeline.js';

export interface SchedulerOptions {
  mode: TaggingMode;
  intervalMs: number;
  log: (message: string) => void;
  now?: () => number;
}

/**
 * Runs pipeline cycles one after another: the next cycle is scheduled only
 * after the previous one finished, so cycles never overlap in this process.
 * Other processes are kept out by the pipeline's lease.
 */
export class PipelineScheduler {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private wakeRequested = false;
  private stopped = false;
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private lastLine: string | null = null;
  last: CycleResult | null = null;
  nextRunAt: number | null = null;

  constructor(
    private readonly pipeline: Pipeline,
    readonly options: SchedulerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get running(): boolean {
    return this.current !== null;
  }

  start(): void {
    this.schedule(0);
  }

  /** Run as soon as the current cycle (if any) ends. Returns false after stop(). */
  wake(): boolean {
    if (this.stopped) return false;
    if (this.current) this.wakeRequested = true;
    else this.schedule(0);
    return true;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = this.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delayMs);
  }

  private tick(): void {
    if (this.stopped || this.current) return;
    this.nextRunAt = null;
    this.current = this.pipeline
      .runCycle({ mode: this.options.mode, signal: this.controller.signal })
      .then((result) => {
        this.last = result;
        this.report(result);
      })
      .catch((error: unknown) => {
        this.options.log(`Tagging cycle crashed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`);
      })
      .finally(() => {
        this.current = null;
        const again = this.wakeRequested;
        this.wakeRequested = false;
        this.schedule(again ? 0 : this.options.intervalMs);
      });
  }

  /** Log a cycle when it did something or its outcome changed; idle repeats stay quiet. */
  private report(result: CycleResult): void {
    const line = formatCycle(result);
    const idle = result.status === 'ok' && !result.categories.changed && (result.sync?.added ?? 0) === 0 && (result.classify?.attempted ?? 0) === 0 && (result.tag?.considered ?? 0) === 0;
    const quiet = idle || result.status === 'busy' || result.status === 'not_ready' || result.status === 'failed';
    const key = quiet ? `${result.status}:${result.error ?? ''}` : null;
    if (key !== null && key === this.lastLine) return;
    this.lastLine = key;
    this.options.log(line);
  }

  /**
   * Stop scheduling, cancel the running cycle, and wait up to `graceMs` for
   * it to finish. Returns false if it was still running when time ran out.
   */
  async stop(graceMs = 10_000): Promise<boolean> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    this.controller.abort();
    if (!this.current) return true;
    let timeout: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      this.current.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
    clearTimeout(timeout);
    return finished;
  }
}
