import { randomUUID } from "node:crypto";
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

export interface MemoryCoordinatorOptions {
  config: MemoryConfig;
  projectKey?: string;
  extractor?: Extractor;
  embedder?: Embedder;
  store?: SQLiteMemoryStore;
  clock?: Clock;
  modelRegistry?: NestedModelRegistry;
}

export class PersistentMemoryCoordinator implements MemoryCoordinator {
  private readonly clock: Clock;
  private readonly store: SQLiteMemoryStore;
  private readonly extractor: Extractor;
  private readonly embedder?: Embedder;
  private readonly worker: MemoryWorker;
  private readonly boundProjectKey?: string;
  private closed = false;

  private readonly config: MemoryConfig;

  private constructor(
    config: MemoryConfig,
    store: SQLiteMemoryStore,
    boundProjectKey: string | undefined,
    extractor: Extractor,
    embedder: Embedder | undefined,
    clock: Clock,
  ) {
    this.config = config;
    this.boundProjectKey = boundProjectKey;
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
      retainUntil: input.capturedAt + this.config.sourceRetentionMs,
      extractorVersion: this.config.extractor.extractorVersion,
      promptVersion: this.config.extractor.promptVersion,
      extractorInput,
    });
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

  async forget(selector: { id: string }): Promise<void> {
    this.ensureOpen();
    this.assertMemoryAccess(selector.id);
    this.store.forget(selector.id, this.clock.now());
  }

  async search(input: SearchInput): Promise<readonly SearchHit[]> {
    this.ensureOpen();
    return this.searchHits(input);
  }

  async pending(): Promise<readonly MemoryRecord[]> {
    this.ensureOpen();
    return this.store
      .listPendingMemories()
      .filter((record) => !this.boundProjectKey || record.scope === "global" || record.scopeKey === this.boundProjectKey);
  }

  async approve(selector: { id: string }): Promise<MemoryRecord> {
    this.ensureOpen();
    this.assertMemoryAccess(selector.id);
    const record = this.store.approve(selector.id, this.clock.now());
    await this.tryEmbed(record);
    return record;
  }

  async reject(selector: { id: string }): Promise<void> {
    this.ensureOpen();
    this.assertMemoryAccess(selector.id);
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

  private ensureOpen(): void {
    if (this.closed) throw new Error("Memory coordinator is shut down");
  }

  private assertProjectKey(projectKey: string): void {
    if (this.boundProjectKey && projectKey !== this.boundProjectKey) {
      throw new Error(`Project scope does not match the active project: ${projectKey}`);
    }
  }

  private assertMemoryAccess(id: string): void {
    if (!this.boundProjectKey) return;
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
