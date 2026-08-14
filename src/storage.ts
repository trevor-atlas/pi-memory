import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  blobToVector,
  buildFtsQuery,
  clampScore,
  normalizeStatement,
  sha256,
  stableId,
  vectorToBlob,
} from "./text.ts";
import type {
  CaptureJobStatus,
  EnqueueReceipt,
  ExtractorInput,
  MemoryCandidate,
  MemoryRecord,
  MemoryScope,
  MemorySource,
  MemoryState,
  MemoryStatus,
  SearchHit,
  ValidatedMemoryCandidate,
} from "./types.ts";
import type { Clock } from "./types.ts";

const SCHEMA_VERSION = 2;
const GLOBAL_SCOPE_KEY = "global";

interface StoredJob {
  jobId: string;
  sourceId: string;
  status: CaptureJobStatus;
  attempts: number;
  result: ValidatedMemoryCandidate[] | undefined;
  requiresApproval: boolean;
  input: ExtractorInput;
  leaseOwner?: string;
  leaseExpiresAt?: number;
}

interface CaptureSourceInput {
  sourceId: string;
  jobId: string;
  sessionId: string;
  projectKey: string;
  branchId: string;
  entryIds: readonly string[];
  turnIndex?: number;
  sourceHash: string;
  payload: string;
  createdAt: number;
  retainUntil: number;
  extractorVersion: string;
  promptVersion: string;
  extractorInput: ExtractorInput;
  requiresApproval?: boolean;
}

interface CommitEmbedding {
  model: string;
  vector: readonly number[];
  contentHash?: string;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, 0);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function withTransaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}

function memoryRowToRecord(row: Record<string, unknown>): MemoryRecord {
  const expiresAt = asNullableNumber(row.expires_at);
  const approvedAt = asNullableNumber(row.approved_at);
  return {
    id: asString(row.id),
    scope: asString(row.scope) as MemoryScope,
    scopeKey: asString(row.scope_key),
    statement: asString(row.statement),
    normalizedStatement: asString(row.normalized_statement),
    kind: asString(row.kind) as MemoryRecord["kind"],
    state: asString(row.state) as MemoryState,
    confidence: clampScore(asNumber(row.confidence)),
    importance: clampScore(asNumber(row.importance)),
    evidence: asString(row.evidence) || undefined,
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
    lastSeenAt: asNumber(row.last_seen_at),
    expiresAt,
    contentHash: asString(row.content_hash),
    approvedAt,
  };
}

class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Capture job lease lost: ${jobId}`);
    this.name = "LeaseLostError";
  }
}

function jobRowToJob(row: Record<string, unknown>): StoredJob {
  return {
    jobId: asString(row.job_id),
    sourceId: asString(row.source_id),
    status: asString(row.status) as CaptureJobStatus,
    attempts: asNumber(row.attempts),
    result: parseJson<ValidatedMemoryCandidate[] | undefined>(row.result_json, undefined),
    requiresApproval: asNumber(row.review_required) === 1,
    input: parseJson<ExtractorInput>(row.extractor_input_json, {
      projectKey: "",
      sessionId: "",
      userText: "",
      assistantText: "",
      toolNames: [],
    }),
    leaseOwner: asString(row.lease_owner) || undefined,
    leaseExpiresAt: asNullableNumber(row.lease_expires_at) ?? undefined,
  };
}

export class SQLiteMemoryStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.db = db;
  }

  static async open(path: string): Promise<SQLiteMemoryStore> {
    if (path !== ":memory:") {
      const parent = dirname(path);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      try {
        await chmod(parent, 0o700);
      } catch {
        // Some virtual filesystems do not support chmod.
      }
    }
    const db = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    try {
      await chmod(path, 0o600);
    } catch {
      // Some virtual filesystems do not support chmod; the parent remains private.
    }
    const store = new SQLiteMemoryStore(path, db);
    store.configure();
    store.migrate();
    return store;
  }

  private configure(): void {
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (this.path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const current = asNumber(this.db.prepare("PRAGMA user_version").get()?.user_version);
    if (current >= SCHEMA_VERSION) return;
    if (current < 0 || current > SCHEMA_VERSION) throw new Error(`Unsupported memory schema version ${current}`);

    withTransaction(this.db, () => {
      if (current === 0) {
        this.db.exec(`
        CREATE TABLE capture_sources (
          source_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          project_key TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          entry_ids_json TEXT NOT NULL,
          turn_index INTEGER,
          source_hash TEXT NOT NULL,
          payload TEXT NOT NULL,
          extractor_input_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          retain_until INTEGER NOT NULL,
          UNIQUE(session_id, source_hash)
        );

        CREATE TABLE capture_jobs (
          job_id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES capture_sources(source_id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'extracted', 'embedding', 'committed', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          available_at INTEGER NOT NULL,
          extractor_version TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          extractor_input_json TEXT NOT NULL,
          result_json TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          review_required INTEGER NOT NULL DEFAULT 0,
          UNIQUE(source_id, extractor_version, prompt_version)
        );
        CREATE INDEX capture_jobs_ready_idx
          ON capture_jobs(status, available_at, lease_expires_at);

        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
          scope_key TEXT NOT NULL,
          statement TEXT NOT NULL,
          normalized_statement TEXT NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'rejected', 'superseded', 'deleted')),
          confidence REAL NOT NULL,
          importance REAL NOT NULL,
          evidence TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          expires_at INTEGER,
          content_hash TEXT NOT NULL,
          approved_at INTEGER,
          UNIQUE(scope, scope_key, content_hash)
        );
        CREATE INDEX memories_scope_idx ON memories(scope, scope_key, state, expires_at);
        CREATE INDEX memories_hash_idx ON memories(content_hash);

        CREATE TABLE memory_sources (
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL REFERENCES capture_sources(source_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL,
          entry_ids_json TEXT NOT NULL,
          PRIMARY KEY(memory_id, source_id)
        );

        CREATE TABLE memory_tombstones (
          memory_id TEXT PRIMARY KEY,
          content_hash TEXT,
          deleted_at INTEGER NOT NULL
        );

        CREATE TABLE embeddings (
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          dimension INTEGER NOT NULL,
          vector_blob BLOB NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('ready', 'stale', 'failed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(memory_id, model)
        );

        CREATE TABLE memory_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE VIRTUAL TABLE memories_fts USING fts5(
          statement,
          evidence,
          content='memories',
          content_rowid='rowid'
        );

        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, statement, evidence)
          VALUES (new.rowid, new.statement, coalesce(new.evidence, ''));
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, statement, evidence)
          VALUES ('delete', old.rowid, old.statement, coalesce(old.evidence, ''));
        END;
        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, statement, evidence)
          VALUES ('delete', old.rowid, old.statement, coalesce(old.evidence, ''));
          INSERT INTO memories_fts(rowid, statement, evidence)
          VALUES (new.rowid, new.statement, coalesce(new.evidence, ''));
        END;

        INSERT INTO memory_settings(key, value) VALUES ('paused', 'false');
        INSERT INTO schema_meta(key, value) VALUES ('created_by', 'pi-memory');
      `);
      } else if (current === 1) {
        this.db.exec("ALTER TABLE capture_jobs ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0;");
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
  }

  get schemaVersion(): number {
    return asNumber(this.db.prepare("PRAGMA user_version").get()?.user_version);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  isPaused(): boolean {
    const row = this.db.prepare("SELECT value FROM memory_settings WHERE key = 'paused'").get();
    return asString(row?.value) === "true";
  }

  setPaused(paused: boolean): void {
    this.db
      .prepare("INSERT INTO memory_settings(key, value) VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(paused ? "true" : "false");
  }

  enqueueCapture(input: CaptureSourceInput): EnqueueReceipt {
    return withTransaction(this.db, () => {
      const sourceResult = this.db
        .prepare(
          `INSERT OR IGNORE INTO capture_sources(
             source_id, session_id, project_key, branch_id, entry_ids_json, turn_index,
             source_hash, payload, extractor_input_json, created_at, retain_until
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sourceId,
          input.sessionId,
          input.projectKey,
          input.branchId,
          JSON.stringify(input.entryIds.slice(0, 64)),
          input.turnIndex ?? null,
          input.sourceHash,
          input.payload,
          JSON.stringify(input.extractorInput),
          input.createdAt,
          input.retainUntil,
        );

      const jobResult = this.db
        .prepare(
          `INSERT OR IGNORE INTO capture_jobs(
             job_id, source_id, status, attempts, available_at, extractor_version,
             prompt_version, extractor_input_json, review_required, created_at, updated_at
           ) VALUES (?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.jobId,
          input.sourceId,
          input.createdAt,
          input.extractorVersion,
          input.promptVersion,
          JSON.stringify(input.extractorInput),
          input.requiresApproval ? 1 : 0,
          input.createdAt,
          input.createdAt,
        );

      return {
        sourceId: input.sourceId,
        jobId: input.jobId,
        inserted: asNumber(sourceResult.changes) > 0 || asNumber(jobResult.changes) > 0,
      };
    });
  }

  recoverExpiredLeases(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE capture_jobs
         SET status = CASE WHEN result_json IS NULL THEN 'pending' ELSE 'extracted' END,
             lease_owner = NULL,
             lease_expires_at = NULL,
             available_at = ?,
             updated_at = ?
         WHERE status IN ('leased', 'embedding')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?`,
      )
      .run(now, now, now);
    return asNumber(result.changes);
  }

  claimNextJob(workerId: string, now: number, leaseMs: number): StoredJob | undefined {
    this.recoverExpiredLeases(now);
    return withTransaction(this.db, () => {
      const row = this.db
        .prepare(
          `SELECT j.*, s.extractor_input_json
           FROM capture_jobs j
           JOIN capture_sources s ON s.source_id = j.source_id
           WHERE j.status IN ('pending', 'extracted')
             AND j.available_at <= ?
             AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= ?)
           ORDER BY j.available_at ASC, j.created_at ASC
           LIMIT 1`,
        )
        .get(now, now);
      if (!row) return undefined;

      const job = row as Record<string, unknown>;
      const jobId = asString(job.job_id);
      const leaseExpiresAt = now + leaseMs;
      this.db
        .prepare(
          `UPDATE capture_jobs
           SET status = 'leased', attempts = attempts + 1, lease_owner = ?,
               lease_expires_at = ?, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(workerId, leaseExpiresAt, now, jobId);
      return jobRowToJob({ ...job, status: "leased", attempts: asNumber(job.attempts) + 1, lease_owner: workerId, lease_expires_at: leaseExpiresAt });
    });
  }

  markExtracted(jobId: string, workerId: string, candidates: readonly ValidatedMemoryCandidate[], now: number): void {
    const result = this.db
      .prepare(
        `UPDATE capture_jobs
         SET status = 'extracted', result_json = ?, updated_at = ?
         WHERE job_id = ? AND status = 'leased' AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .run(JSON.stringify(candidates), now, jobId, workerId, now);
    if (asNumber(result.changes) !== 1) throw new LeaseLostError(jobId);
  }

  markEmbedding(jobId: string, workerId: string, now: number): void {
    const result = this.db
      .prepare(
        `UPDATE capture_jobs SET status = 'embedding', updated_at = ?
         WHERE job_id = ? AND status IN ('leased', 'extracted') AND lease_owner = ?
           AND lease_expires_at > ?`,
      )
      .run(now, jobId, workerId, now);
    if (asNumber(result.changes) !== 1) throw new LeaseLostError(jobId);
  }

  commitJob(
    jobId: string,
    workerId: string,
    sourceId: string,
    candidates: readonly ValidatedMemoryCandidate[],
    embeddings: readonly CommitEmbedding[],
    now: number,
  ): readonly MemoryRecord[] {
    return withTransaction(this.db, () => {
      const lease = this.db
        .prepare(
          `SELECT status, lease_owner, lease_expires_at, review_required
           FROM capture_jobs WHERE job_id = ?`,
        )
        .get(jobId) as Record<string, unknown> | undefined;
      if (
        !lease ||
        asString(lease.lease_owner) !== workerId ||
        !["leased", "extracted", "embedding"].includes(asString(lease.status)) ||
        asNullableNumber(lease.lease_expires_at) === null ||
        (asNullableNumber(lease.lease_expires_at) as number) <= now
      ) {
        throw new LeaseLostError(jobId);
      }

      const requiresApproval = asNumber(lease.review_required) === 1;
      const records: MemoryRecord[] = [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const scope: MemoryScope = candidate.scopeCandidate;
        const scopeKey = scope === "global" ? GLOBAL_SCOPE_KEY : this.projectKeyForSource(sourceId);
        const contentHash = sha256(`${scope}\u001f${scopeKey}\u001f${candidate.normalizedStatement}`);
        const tombstone = this.db
          .prepare("SELECT memory_id FROM memory_tombstones WHERE content_hash = ?")
          .get(contentHash);
        if (tombstone) continue;
        const id = randomUUID();
        const state: MemoryState = requiresApproval || scope === "global" ? "pending" : "active";
        const approvedAt = state === "active" ? now : null;
        this.db
          .prepare(
            `INSERT INTO memories(
               id, scope, scope_key, statement, normalized_statement, kind, state,
               confidence, importance, evidence, created_at, updated_at, last_seen_at,
               expires_at, content_hash, approved_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope, scope_key, content_hash) DO UPDATE SET
               updated_at = excluded.updated_at,
               last_seen_at = excluded.last_seen_at,
               confidence = max(memories.confidence, excluded.confidence),
               importance = max(memories.importance, excluded.importance),
               evidence = coalesce(memories.evidence, excluded.evidence),
               expires_at = coalesce(excluded.expires_at, memories.expires_at)`,
          )
          .run(
            id,
            scope,
            scopeKey,
            candidate.statement,
            candidate.normalizedStatement,
            candidate.kind,
            state,
            clampScore(candidate.confidence),
            clampScore(candidate.importance),
            candidate.evidence ?? null,
            now,
            now,
            now,
            candidate.expiresAt ?? null,
            contentHash,
            approvedAt,
          );

        const memoryRow = this.db
          .prepare("SELECT * FROM memories WHERE scope = ? AND scope_key = ? AND content_hash = ?")
          .get(scope, scopeKey, contentHash);
        if (!memoryRow) throw new Error("Memory upsert did not return a row");
        const memory = memoryRowToRecord(memoryRow as Record<string, unknown>);
        records.push(memory);

        const sourceRow = this.db
          .prepare("SELECT session_id, entry_ids_json FROM capture_sources WHERE source_id = ?")
          .get(sourceId) as Record<string, unknown> | undefined;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO memory_sources(memory_id, source_id, session_id, entry_ids_json)
             VALUES (?, ?, ?, ?)`,
          )
          .run(
            memory.id,
            sourceId,
            asString(sourceRow?.session_id),
            asString(sourceRow?.entry_ids_json, "[]"),
          );

        const embedding = embeddings[candidateIndex];
        if (embedding && embedding.vector.length > 0) {
          this.db
            .prepare(
              `INSERT INTO embeddings(memory_id, model, dimension, vector_blob, content_hash, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)
               ON CONFLICT(memory_id, model) DO UPDATE SET
                 dimension = excluded.dimension,
                 vector_blob = excluded.vector_blob,
                 content_hash = excluded.content_hash,
                 status = 'ready',
                 updated_at = excluded.updated_at`,
            )
            .run(
              memory.id,
              embedding.model,
              embedding.vector.length,
              vectorToBlob(embedding.vector),
              embedding.contentHash ?? memory.contentHash,
              now,
              now,
            );
        }
      }

      const jobResult = this.db
        .prepare(
          `UPDATE capture_jobs
           SET status = 'committed', lease_owner = NULL, lease_expires_at = NULL,
               last_error = NULL, updated_at = ?
           WHERE job_id = ? AND status IN ('leased', 'extracted', 'embedding')
             AND lease_owner = ? AND lease_expires_at > ?`,
        )
        .run(now, jobId, workerId, now);
      if (asNumber(jobResult.changes) !== 1) throw new LeaseLostError(jobId);
      return records;
    });
  }

  retryJob(jobId: string, workerId: string, now: number, error: string, maxAttempts: number, retryAt: number): void {
    this.db
      .prepare(
        `UPDATE capture_jobs
         SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE CASE WHEN result_json IS NULL THEN 'pending' ELSE 'extracted' END END,
             lease_owner = NULL, lease_expires_at = NULL, available_at = ?,
             last_error = ?, updated_at = ?
         WHERE job_id = ? AND lease_owner = ?`,
      )
      .run(maxAttempts, retryAt, error.slice(0, 2_000), now, jobId, workerId);
  }

  getJob(jobId: string): StoredJob | undefined {
    const row = this.db
      .prepare(
        `SELECT j.*, s.extractor_input_json
         FROM capture_jobs j JOIN capture_sources s ON s.source_id = j.source_id
         WHERE j.job_id = ?`,
      )
      .get(jobId);
    return row ? jobRowToJob(row as Record<string, unknown>) : undefined;
  }

  purgeExpiredSources(now: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM capture_sources
         WHERE retain_until <= ?
           AND source_id IN (SELECT source_id FROM capture_jobs WHERE status IN ('committed', 'failed'))`,
      )
      .run(now);
    return asNumber(result.changes);
  }

  searchLexical(query: string, projectKey: string, limit: number, now: number): SearchHit[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(memories_fts) AS bm25_score
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ?
           AND m.state = 'active'
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND ((m.scope = 'project' AND m.scope_key = ?) OR m.scope = 'global')
         ORDER BY bm25_score ASC, m.importance DESC, m.updated_at DESC
         LIMIT ?`,
      )
      .all(ftsQuery, now, projectKey, Math.max(1, Math.min(200, limit)));

    return rows.map((row) => {
      const record = memoryRowToRecord(row as Record<string, unknown>);
      const bm25 = asNumber((row as Record<string, unknown>).bm25_score, 100);
      const lexicalScore = 1 / (1 + Math.max(0, bm25));
      return {
        memory: record,
        lexicalScore,
        semanticScore: 0,
        score: lexicalScore,
      };
    });
  }

  listActiveMemories(projectKey: string, now: number): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE state = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
           AND ((scope = 'project' AND scope_key = ?) OR scope = 'global')`,
      )
      .all(now, projectKey);
    return rows.map((row) => memoryRowToRecord(row as Record<string, unknown>));
  }

  listAllActiveMemories(now: number): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE state = 'active' AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(now);
    return rows.map((row) => memoryRowToRecord(row as Record<string, unknown>));
  }

  listPendingMemories(): MemoryRecord[] {
    const rows = this.db.prepare("SELECT * FROM memories WHERE state = 'pending' ORDER BY created_at ASC").all();
    return rows.map((row) => memoryRowToRecord(row as Record<string, unknown>));
  }

  attachEmbedding(
    memoryId: string,
    model: string,
    vector: readonly number[],
    contentHash: string,
    now: number,
  ): void {
    if (vector.length === 0) return;
    this.db
      .prepare(
        `INSERT INTO embeddings(memory_id, model, dimension, vector_blob, content_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?)
         ON CONFLICT(memory_id, model) DO UPDATE SET
           dimension = excluded.dimension,
           vector_blob = excluded.vector_blob,
           content_hash = excluded.content_hash,
           status = 'ready',
           updated_at = excluded.updated_at`,
      )
      .run(memoryId, model, vector.length, vectorToBlob(vector), contentHash, now, now);
  }

  listEmbeddings(model: string, projectKey: string, now: number): Array<{ memory: MemoryRecord; vector: number[] }> {
    const rows = this.db
      .prepare(
        `SELECT m.*, e.vector_blob
         FROM embeddings e JOIN memories m ON m.id = e.memory_id
         WHERE e.model = ? AND e.status = 'ready' AND m.state = 'active'
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND ((m.scope = 'project' AND m.scope_key = ?) OR m.scope = 'global')`,
      )
      .all(model, now, projectKey);
    return rows.map((row) => ({
      memory: memoryRowToRecord(row as Record<string, unknown>),
      vector: blobToVector((row as Record<string, unknown>).vector_blob),
    }));
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? memoryRowToRecord(row as Record<string, unknown>) : undefined;
  }

  remember(input: {
    id?: string;
    scope: MemoryScope;
    scopeKey: string;
    statement: string;
    normalizedStatement: string;
    kind: MemoryRecord["kind"];
    confidence: number;
    importance: number;
    evidence?: string;
    expiresAt?: number | null;
    now: number;
  }): MemoryRecord {
    return withTransaction(this.db, () => {
      const id = input.id ?? randomUUID();
      const contentHash = sha256(`${input.scope}\u001f${input.scopeKey}\u001f${input.normalizedStatement}`);
      // An explicit remember is an intentional resurrection; automatic capture is not.
      this.db.prepare("DELETE FROM memory_tombstones WHERE content_hash = ?").run(contentHash);
      this.db
        .prepare(
          `INSERT INTO memories(
             id, scope, scope_key, statement, normalized_statement, kind, state,
             confidence, importance, evidence, created_at, updated_at, last_seen_at,
             expires_at, content_hash, approved_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, scope_key, content_hash) DO UPDATE SET
             updated_at = excluded.updated_at,
             last_seen_at = excluded.last_seen_at,
             confidence = max(memories.confidence, excluded.confidence),
             importance = max(memories.importance, excluded.importance),
             evidence = coalesce(memories.evidence, excluded.evidence),
             expires_at = coalesce(excluded.expires_at, memories.expires_at),
             state = 'active', approved_at = excluded.approved_at`,
        )
        .run(
          id,
          input.scope,
          input.scopeKey,
          input.statement,
          input.normalizedStatement,
          input.kind,
          clampScore(input.confidence),
          clampScore(input.importance),
          input.evidence ?? null,
          input.now,
          input.now,
          input.now,
          input.expiresAt ?? null,
          contentHash,
          input.now,
        );
      const row = this.db
        .prepare("SELECT * FROM memories WHERE scope = ? AND scope_key = ? AND content_hash = ?")
        .get(input.scope, input.scopeKey, contentHash);
      if (!row) throw new Error("Explicit memory upsert did not return a row");
      return memoryRowToRecord(row as Record<string, unknown>);
    });
  }

  approve(id: string, now: number): MemoryRecord {
    return withTransaction(this.db, () => {
      const result = this.db
        .prepare(
          `UPDATE memories SET state = 'active', approved_at = ?, updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(now, now, id);
      if (asNumber(result.changes) === 0) {
        const existing = this.getMemory(id);
        if (!existing) throw new Error(`Memory not found: ${id}`);
        if (existing.state !== "active") throw new Error(`Memory is not pending: ${id}`);
        return existing;
      }
      const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
      if (!row) throw new Error(`Memory not found after approval: ${id}`);
      return memoryRowToRecord(row as Record<string, unknown>);
    });
  }

  reject(id: string, now: number): void {
    const result = this.db
      .prepare("UPDATE memories SET state = 'rejected', updated_at = ? WHERE id = ? AND state = 'pending'")
      .run(now, id);
    if (asNumber(result.changes) === 0) {
      const existing = this.getMemory(id);
      if (!existing) throw new Error(`Memory not found: ${id}`);
    }
  }

  forget(id: string, now: number): void {
    withTransaction(this.db, () => {
      const row = this.db.prepare("SELECT id, content_hash FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) {
        const tombstone = this.db.prepare("SELECT memory_id FROM memory_tombstones WHERE memory_id = ?").get(id);
        if (!tombstone) throw new Error(`Memory not found: ${id}`);
        return;
      }
      this.db
        .prepare("INSERT OR REPLACE INTO memory_tombstones(memory_id, content_hash, deleted_at) VALUES (?, ?, ?)")
        .run(id, asString(row.content_hash) || null, now);
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    });
  }

  rebuildFts(): void {
    this.db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');");
  }

  private projectKeyForSource(sourceId: string): string {
    const row = this.db.prepare("SELECT project_key FROM capture_sources WHERE source_id = ?").get(sourceId);
    const projectKey = asString((row as Record<string, unknown> | undefined)?.project_key);
    if (!projectKey) throw new Error(`Capture source not found: ${sourceId}`);
    return projectKey;
  }

  status(): MemoryStatus {
    const counts = this.db
      .prepare(
        `SELECT
           (SELECT count(*) FROM capture_jobs WHERE status = 'pending') AS pending_jobs,
           (SELECT count(*) FROM capture_jobs WHERE status IN ('leased', 'extracted', 'embedding')) AS leased_jobs,
           (SELECT count(*) FROM capture_jobs WHERE status = 'failed') AS failed_jobs,
           (SELECT count(*) FROM memories WHERE state = 'active') AS active_memories,
           (SELECT count(*) FROM memories WHERE state = 'pending') AS pending_memories,
           (SELECT count(*) FROM memories WHERE state = 'active' AND scope = 'global') AS global_memories,
           (SELECT count(*) FROM memories WHERE state = 'active' AND scope = 'project') AS project_memories,
           (SELECT last_error FROM capture_jobs WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1) AS last_error`,
      )
      .get() as Record<string, unknown>;
    return {
      paused: this.isPaused(),
      schemaVersion: this.schemaVersion,
      pendingJobs: asNumber(counts.pending_jobs),
      leasedJobs: asNumber(counts.leased_jobs),
      failedJobs: asNumber(counts.failed_jobs),
      activeMemories: asNumber(counts.active_memories),
      pendingMemories: asNumber(counts.pending_memories),
      globalMemories: asNumber(counts.global_memories),
      projectMemories: asNumber(counts.project_memories),
      databasePath: this.path,
      lastError: asString(counts.last_error) || undefined,
    };
  }
}

export type { CaptureSourceInput, CommitEmbedding, StoredJob };
export { GLOBAL_SCOPE_KEY, SCHEMA_VERSION };
