import { randomUUID } from "node:crypto";
import { validateMemoryCandidates } from "./validation.ts";
import type {
  Clock,
  Embedder,
  Extractor,
  MemoryConfig,
} from "./types.ts";
import { systemClock } from "./types.ts";
import { SQLiteMemoryStore, type StoredJob } from "./storage.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface MemoryWorkerOptions {
  store: SQLiteMemoryStore;
  extractor: Extractor;
  embedder?: Embedder;
  config: MemoryConfig;
  clock?: Clock;
}

export class MemoryWorker {
  private readonly options: MemoryWorkerOptions;
  private readonly workerId = `pi-memory-${randomUUID()}`;
  private readonly clock: Clock;
  private readonly abortController = new AbortController();
  private running = false;
  private loopPromise: Promise<void> | undefined;
  private activeJob: Promise<void> | undefined;

  constructor(options: MemoryWorkerOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController.signal.throwIfAborted?.();
    this.loopPromise = this.runLoop();
  }

  async stop(drainMs = this.options.config.worker.shutdownDrainMs): Promise<void> {
    if (!this.running) return;
    const loop = this.loopPromise;
    const deadline = this.clock.now() + Math.max(0, drainMs);
    while (this.activeJob && this.clock.now() < deadline) {
      await Promise.race([this.activeJob, sleep(Math.max(1, deadline - this.clock.now()))]);
    }
    this.running = false;
    this.abortController.abort();
    if (loop) await Promise.race([loop, sleep(Math.max(1, deadline - this.clock.now()))]);
  }

  async processOne(): Promise<boolean> {
    const now = this.clock.now();
    const job = this.options.store.claimNextJob(
      this.workerId,
      now,
      this.options.config.worker.leaseMs,
    );
    if (!job) return false;

    const work = this.processJob(job);
    this.activeJob = work;
    try {
      await work;
    } finally {
      if (this.activeJob === work) this.activeJob = undefined;
    }
    return true;
  }

  private async runLoop(): Promise<void> {
    while (this.running && !this.abortController.signal.aborted) {
      try {
        const processed = await this.processOne();
        if (!processed) {
          await sleep(this.options.config.worker.pollIntervalMs, this.abortController.signal);
        }
      } catch {
        // A malformed job or a transient database error must not kill the worker.
        await sleep(this.options.config.worker.pollIntervalMs, this.abortController.signal);
      }
    }
  }

  private async processJob(job: StoredJob): Promise<void> {
    const signal = this.abortController.signal;
    try {
      const validationOptions = {
        maxCandidates: this.options.config.extractor.maxCandidates,
        minConfidence: this.options.config.extractor.minConfidence,
        minImportance: this.options.config.extractor.minImportance,
        requireEvidence: this.options.config.extractor.requireEvidence,
      };
      let candidates = job.result ? validateMemoryCandidates(job.result, validationOptions) : undefined;
      if (!candidates) {
        const extracted = await this.options.extractor.extract(job.input, signal);
        if (signal.aborted) return;
        candidates = validateMemoryCandidates(extracted, validationOptions);
        this.options.store.markExtracted(job.jobId, this.workerId, candidates, this.clock.now());
      }

      if (signal.aborted) return;
      if (candidates.length === 0 || !this.options.embedder || !this.options.config.embedding.enabled) {
        this.options.store.commitJob(job.jobId, this.workerId, job.sourceId, candidates, [], this.clock.now());
        return;
      }

      this.options.store.markEmbedding(job.jobId, this.workerId, this.clock.now());
      const vectors = await this.options.embedder.embed(
        candidates.map((candidate) => candidate.statement),
        signal,
      );
      if (signal.aborted) return;
      if (vectors.length !== candidates.length) {
        throw new Error(`Embedder returned ${vectors.length} vectors for ${candidates.length} memories`);
      }

      this.options.store.commitJob(
        job.jobId,
        this.workerId,
        job.sourceId,
        candidates,
        vectors.map((vector) => ({ model: this.options.config.embedding.model, vector })),
        this.clock.now(),
      );
    } catch (error) {
      if (signal.aborted) return;
      const now = this.clock.now();
      const retryDelay = Math.min(
        15 * 60 * 1000,
        this.options.config.worker.retryBaseMs * 2 ** Math.max(0, job.attempts - 1),
      );
      this.options.store.retryJob(
        job.jobId,
        this.workerId,
        now,
        errorMessage(error),
        this.options.config.worker.maxAttempts,
        now + retryDelay,
      );
    }
  }
}
