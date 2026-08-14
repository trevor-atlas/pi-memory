import { homedir } from "node:os";
import { join } from "node:path";
import { buildSanitizedExtractorInput, buildSanitizedSourcePayload } from "./redaction.ts";
import { buildTransientRecall, mergeAndRank, semanticCandidates } from "./recall.ts";
import { SQLiteMemoryStore } from "./storage.ts";
import {
  boundedText,
  clampScore,
  normalizeStatement,
  sha256,
  stableId,
} from "./text.ts";
import {
  DEFAULT_CONFIG,
  systemClock,
} from "./types.ts";
import type {
  Clock,
  Embedder,
  EnqueueReceipt,
  ExplicitMemory,
  Extractor,
  MemoryConfig,
  MemoryCoordinator,
  MemoryRecord,
  MemoryStatus,
  RememberInput,
  SearchHit,
  SearchInput,
  SettledTurnSnapshot,
  TransientRecall,
} from "./types.ts";
import { isSafeMemoryText } from "./redaction.ts";
import { MemoryWorker } from "./worker.ts";
import { DisabledExtractor, PiRemoteExtractor, type NestedModelRegistry } from "./extractor.ts";
import { OllamaEmbedder } from "./embeddings.ts";
import { scanHistoricalSessions } from "./session-backfill.ts";
import { resolveProjectKey } from "./project-key.ts";

export interface MemoryCoordinatorOptions {
  config: MemoryConfig;
  projectKey?: string;
  extractor?: Extractor;
  embedder?: Embedder;
  store?: SQLiteMemoryStore;
  clock?: Clock;
  modelRegistry?: NestedModelRegistry;
  sessionDirectory?: string;
}

export interface BackfillInput {
  all?: boolean;
  maxSessions?: number;
}

export interface BackfillReceipt {
  sessionsScanned: number;
  sessionsQueued: number;
  turnsFound: number;
  jobsEnqueued: number;
  jobsAlreadyQueued: number;
}

export class PersistentMemoryCoordinator implements MemoryCoordinator {
  private readonly clock: Clock;
  private readonly store: SQLiteMemoryStore;
  private readonly extractor: Extractor;
  private readonly embedder?: Embedder;
  private readonly worker: MemoryWorker;
  private readonly boundProjectKey?: string;
  private readonly sessionDirectory: string;
  private closed = false;

  private readonly config: MemoryConfig;

  private constructor(
    config: MemoryConfig,
    store: SQLiteMemoryStore,
    boundProjectKey: string | undefined,
    extractor: Extractor,
    embedder: Embedder | undefined,
    clock: Clock,
    sessionDirectory: string,
  ) {
    this.config = config;
    this.boundProjectKey = boundProjectKey;
    this.sessionDirectory = sessionDirectory;
    this.clock = clock;
    this.store = store;
    this.extractor = extractor;
    this.embedder = embedder;
    this.worker = new MemoryWorker({
      store,
      extractor,
      embedder,
      config,
      clock,
    });
  }

  static async open(options: MemoryCoordinatorOptions): Promise<PersistentMemoryCoordinator> {
    const clock = options.clock ?? systemClock;
    const store = options.store ?? (await SQLiteMemoryStore.open(options.config.databasePath));
    const extractor =
      options.extractor ??
      (options.modelRegistry
        ? new PiRemoteExtractor(options.modelRegistry, options.config.extractor)
        : new DisabledExtractor());
    const embedder =
      options.embedder ??
      (options.config.embedding.enabled
        ? new OllamaEmbedder(options.config.embedding)
        : undefined);
    const coordinator = new PersistentMemoryCoordinator(
      options.config,
      store,
      options.projectKey,
      extractor,
      embedder,
      clock,
      options.sessionDirectory ?? join(homedir(), ".pi", "agent", "sessions"),
    );
    store.recoverExpiredLeases(clock.now());
    store.purgeExpiredSources(clock.now());
    if (options.config.enabled) coordinator.worker.start();
    return coordinator;
  }

  async prepareTurn(input: {
    prompt: string;
    projectKey: string;
    sessionId: string;
  }): Promise<TransientRecall> {
    this.ensureOpen();
    this.assertProjectKey(input.projectKey);
    if (!this.config.enabled || !input.prompt.trim()) {
      return buildTransientRecall(input.prompt, [], this.config.recall);
    }

    const hits = await this.searchHits({
      query: input.prompt,
      projectKey: input.projectKey,
      limit: Math.max(this.config.recall.lexicalLimit, this.config.recall.semanticLimit),
    });
    return buildTransientRecall(input.prompt, hits, this.config.recall);
  }

  async enqueueTurn(input: SettledTurnSnapshot): Promise<EnqueueReceipt> {
    this.ensureOpen();
    this.assertProjectKey(input.projectKey);
    if (!this.config.enabled || !this.config.automaticCapture || this.store.isPaused()) {
      return { sourceId: "", jobId: "", inserted: false };
    }

    return this.enqueueSnapshot(input, {
      requiresApproval: false,
      retainUntil: input.capturedAt + this.config.sourceRetentionMs,
    });
  }

  async backfill(input: BackfillInput = {}): Promise<BackfillReceipt> {
    this.ensureOpen();
    if (!this.config.enabled) throw new Error("Memory is disabled");
    if (this.store.isPaused()) throw new Error("Memory capture is paused");
    if (!input.all && !this.boundProjectKey) {
      throw new Error("Historical backfill requires a bound project or an explicit all-projects request");
    }

    const sessionLimit = input.maxSessions === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(input.maxSessions));
    if (sessionLimit === 0) {
      return { sessionsScanned: 0, sessionsQueued: 0, turnsFound: 0, jobsEnqueued: 0, jobsAlreadyQueued: 0 };
    }
    const sessions = await scanHistoricalSessions({
      sessionDirectory: this.sessionDirectory,
      projectKey: input.all ? undefined : this.boundProjectKey,
      resolveProjectKey,
    });
    let sessionsScanned = 0;
    let sessionsQueued = 0;
    let turnsFound = 0;
    let jobsEnqueued = 0;
    let jobsAlreadyQueued = 0;
    const retainUntil = this.clock.now() + this.config.sourceRetentionMs;
    for (const session of sessions) {
      sessionsScanned += 1;
      let newJobsInSession = 0;
      for (const turn of session.turns) {
        turnsFound += 1;
        const receipt = this.enqueueSnapshot(turn, {
          requiresApproval: true,
          retainUntil,
        });
        if (receipt.inserted) {
          jobsEnqueued += 1;
          newJobsInSession += 1;
        } else {
          jobsAlreadyQueued += 1;
        }
      }
      if (newJobsInSession > 0) {
        sessionsQueued += 1;
        if (sessionsQueued >= sessionLimit) break;
      }
    }
    return {
      sessionsScanned,
      sessionsQueued,
      turnsFound,
      jobsEnqueued,
      jobsAlreadyQueued,
    };
  }

  async remember(input: RememberInput): Promise<MemoryRecord> {
    this.ensureOpen();
    if (input.scope === "project") this.assertProjectKey(input.projectKey);
    const statement = boundedText(input.statement, 600);
    if (statement.length < 3) throw new Error("Memory text is empty or too short");
    if (!isSafeMemoryText(statement)) throw new Error("Memory text contains unsafe instructions or secrets");

    const evidence = input.evidence ? boundedText(input.evidence, 800) : undefined;
    if (evidence && !isSafeMemoryText(evidence)) throw new Error("Memory evidence contains unsafe instructions or secrets");

    const record = this.store.remember({
      scope: input.scope,
      scopeKey: input.scope === "global" ? "global" : input.projectKey,
      statement,
      normalizedStatement: normalizeStatement(statement),
      kind: input.kind ?? (input.scope === "global" ? "preference" : "project_fact"),
      confidence: clampScore(input.confidence ?? 1),
      importance: clampScore(input.importance ?? 1),
      evidence,
      expiresAt: input.expiresAt,
      now: this.clock.now(),
    });

    await this.tryEmbed(record);
    return record;
  }

  async forget(selector: { id: string; all?: boolean }): Promise<void> {
    this.ensureOpen();
    this.assertMemoryAccess(selector.id, selector.all === true);
    this.store.forget(selector.id, this.clock.now());
  }

  async search(input: SearchInput): Promise<readonly SearchHit[]> {
    this.ensureOpen();
    return this.searchHits(input);
  }

  async pending(input?: { all?: boolean }): Promise<readonly MemoryRecord[]> {
    this.ensureOpen();
    const includeAll = input?.all === true;
    return this.store
      .listPendingMemories()
      .filter((record) => includeAll || !this.boundProjectKey || record.scope === "global" || record.scopeKey === this.boundProjectKey);
  }

  async editPending(selector: { id: string; statement: string; all?: boolean }): Promise<MemoryRecord> {
    this.ensureOpen();
    this.assertMemoryAccess(selector.id, selector.all === true);
    const statement = boundedText(selector.statement, 600);
    if (statement.length < 3) throw new Error("Memory text is empty or too short");
    if (!isSafeMemoryText(statement)) throw new Error("Memory text contains unsafe instructions or secrets");
    return this.store.editPending(selector.id, statement, normalizeStatement(statement), this.clock.now());
  }

  async approve(selector: { id: string; all?: boolean }): Promise<MemoryRecord> {
    this.ensureOpen();
    this.assertMemoryAccess(selector.id, selector.all === true);
    const record = this.store.approve(selector.id, this.clock.now());
    await this.tryEmbed(record);
    return record;
  }

  async reject(selector: { id: string; all?: boolean }): Promise<void> {
    this.ensureOpen();
    this.assertMemoryAccess(selector.id, selector.all === true);
    this.store.reject(selector.id, this.clock.now());
  }

  async rebuild(input?: { projectKey?: string; all?: boolean }): Promise<void> {
    this.ensureOpen();
    if (input?.projectKey) this.assertProjectKey(input.projectKey);
    this.store.rebuildFts();
    if (!this.embedder || !this.config.embedding.enabled) return;
    const projectKey = input?.all ? undefined : input?.projectKey ?? this.boundProjectKey;
    const memories = projectKey
      ? this.store.listActiveMemories(projectKey, this.clock.now())
      : this.store.listAllActiveMemories(this.clock.now());
    for (const memory of memories) {
      this.ensureOpen();
      await this.tryEmbed(memory);
    }
  }

  async pause(): Promise<void> {
    this.ensureOpen();
    this.store.setPaused(true);
  }

  async resume(): Promise<void> {
    this.ensureOpen();
    this.store.setPaused(false);
  }

  async status(): Promise<MemoryStatus> {
    this.ensureOpen();
    return this.store.status();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.worker.stop(this.config.worker.shutdownDrainMs);
    this.store.close();
  }

  private enqueueSnapshot(
    input: SettledTurnSnapshot,
    options: { requiresApproval: boolean; retainUntil: number },
  ): EnqueueReceipt {
    const sanitized = buildSanitizedSourcePayload(input);
    const extractorInput = buildSanitizedExtractorInput(input);
    // The source identity describes the settled turn, not when it was observed or
    // which extractor version happened to process it. Extractor/prompt versions belong
    // to the job identity so a new version can reprocess the same source safely.
    const sourceHash = sha256(
      JSON.stringify({
        sessionId: input.sessionId,
        projectKey: input.projectKey,
        branchId: input.branchId,
        sourceEntryIds: input.sourceEntryIds,
        userText: extractorInput.userText,
        assistantText: extractorInput.assistantText,
        toolNames: extractorInput.toolNames,
      }),
    );
    const sourceId = stableId("capture-source", input.sessionId, input.branchId, sourceHash);
    const jobId = stableId(
      "capture-job",
      sourceId,
      this.config.extractor.extractorVersion,
      this.config.extractor.promptVersion,
    );
    return this.store.enqueueCapture({
      sourceId,
      jobId,
      sessionId: input.sessionId,
      projectKey: input.projectKey,
      branchId: input.branchId,
      entryIds: input.sourceEntryIds,
      turnIndex: input.turnIndex,
      sourceHash,
      payload: sanitized.payload,
      createdAt: input.capturedAt,
      retainUntil: options.retainUntil,
      extractorVersion: this.config.extractor.extractorVersion,
      promptVersion: this.config.extractor.promptVersion,
      extractorInput,
      requiresApproval: options.requiresApproval,
    });
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Memory coordinator is shut down");
  }

  private assertProjectKey(projectKey: string): void {
    if (this.boundProjectKey && projectKey !== this.boundProjectKey) {
      throw new Error(`Project scope does not match the active project: ${projectKey}`);
    }
  }

  private assertMemoryAccess(id: string, allowAll = false): void {
    if (!this.boundProjectKey || allowAll) return;
    const record = this.store.getMemory(id);
    if (record && record.scope === "project" && record.scopeKey !== this.boundProjectKey) {
      throw new Error("Memory belongs to a different project");
    }
  }

  private async searchHits(input: SearchInput): Promise<SearchHit[]> {
    this.assertProjectKey(input.projectKey);
    if (!this.config.enabled || !input.query.trim()) return [];
    const now = this.clock.now();
    const lexical = this.store.searchLexical(
      input.query,
      input.projectKey,
      input.limit ?? this.config.recall.lexicalLimit,
      now,
    );
    let semantic: ReturnType<typeof semanticCandidates> = [];
    if (this.embedder && this.config.embedding.enabled) {
      try {
        const queryVectors = await this.embedder.embed(
          [input.query.slice(0, this.config.extractor.maxInputChars)],
          AbortSignal.timeout(this.config.embedding.timeoutMs),
        );
        if (this.closed) throw new Error("Memory coordinator is shut down");
        const queryVector = queryVectors[0];
        if (queryVector) {
          semantic = semanticCandidates(
            queryVector,
            this.store.listEmbeddings(this.config.embedding.model, input.projectKey, now),
            input.limit ?? this.config.recall.semanticLimit,
            this.config.recall.semanticMinScore,
          );
        }
      } catch {
        // Ollama is an optional accelerator. Lexical search remains the correctness path.
      }
    }
    return mergeAndRank(lexical, semantic, now, input.limit ?? this.config.recall.maxMemories);
  }

  private async tryEmbed(record: MemoryRecord): Promise<void> {
    if (!this.embedder || !this.config.embedding.enabled) return;
    try {
      const vectors = await this.embedder.embed([record.statement], AbortSignal.timeout(this.config.embedding.timeoutMs));
      if (this.closed) return;
      const vector = vectors[0];
      if (vector && vector.length > 0) {
        this.store.attachEmbedding(record.id, this.config.embedding.model, vector, record.contentHash, this.clock.now());
      }
    } catch {
      // Explicit writes are durable even when Ollama is unavailable.
    }
  }
}

export type MemoryConfigOverrides = Partial<Omit<MemoryConfig, "databasePath" | "worker" | "extractor" | "embedding" | "recall">> & {
  worker?: Partial<MemoryConfig["worker"]>;
  extractor?: Partial<MemoryConfig["extractor"]>;
  embedding?: Partial<MemoryConfig["embedding"]>;
  recall?: Partial<MemoryConfig["recall"]>;
};

export function withDefaultConfig(
  databasePath: string,
  overrides: MemoryConfigOverrides = {},
): MemoryConfig {
  const base = structuredClone(DEFAULT_CONFIG as unknown as MemoryConfig);
  return {
    ...base,
    ...overrides,
    databasePath,
    worker: { ...base.worker, ...overrides.worker },
    extractor: { ...base.extractor, ...overrides.extractor },
    embedding: { ...base.embedding, ...overrides.embedding },
    recall: { ...base.recall, ...overrides.recall },
  };
}

export type { ExplicitMemory };
