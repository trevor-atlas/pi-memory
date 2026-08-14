export type MemoryScope = "project" | "global";

export type MemoryKind =
  | "preference"
  | "project_fact"
  | "decision"
  | "workflow_lesson";

export type MemoryState =
  | "pending"
  | "active"
  | "rejected"
  | "superseded"
  | "deleted";

export type CaptureJobStatus =
  | "pending"
  | "leased"
  | "extracted"
  | "embedding"
  | "committed"
  | "failed";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export interface ProjectResolver {
  resolve(cwd: string): Promise<string>;
}

export interface TurnSnapshot {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly branchId: string;
  readonly sourceEntryIds: readonly string[];
  readonly turnIndex?: number;
  readonly userText: string;
  readonly assistantText: string;
  readonly toolNames: readonly string[];
  readonly recentDigest?: string;
  readonly capturedAt: number;
}

export type SettledTurnSnapshot = TurnSnapshot;

export interface ExplicitMemory {
  statement: string;
  scope: MemoryScope;
  projectKey?: string;
  kind?: MemoryKind;
  confidence?: number;
  importance?: number;
  evidence?: string;
  expiresAt?: number | null;
}

export interface MemoryCandidate {
  statement: string;
  kind: MemoryKind;
  confidence: number;
  importance: number;
  evidence?: string;
  scopeCandidate: MemoryScope;
  expiresAt?: number | null;
}

export interface ValidatedMemoryCandidate extends MemoryCandidate {
  normalizedStatement: string;
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  scopeKey: string;
  statement: string;
  normalizedStatement: string;
  kind: MemoryKind;
  state: MemoryState;
  confidence: number;
  importance: number;
  evidence?: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  expiresAt?: number | null;
  contentHash: string;
  approvedAt?: number | null;
}

export interface MemorySource {
  memoryId: string;
  sourceId: string;
  sessionId: string;
  entryIds: readonly string[];
}

export interface SearchHit {
  memory: MemoryRecord;
  lexicalScore: number;
  semanticScore: number;
  score: number;
}

export interface TransientRecall {
  id: string;
  block: string;
  hits: readonly SearchHit[];
}

export interface EnqueueReceipt {
  sourceId: string;
  jobId: string;
  inserted: boolean;
}

export interface MemorySelector {
  id: string;
  all?: boolean;
}

export interface MemoryStatus {
  paused: boolean;
  schemaVersion: number;
  pendingJobs: number;
  leasedJobs: number;
  failedJobs: number;
  activeMemories: number;
  pendingMemories: number;
  globalMemories: number;
  projectMemories: number;
  databasePath: string;
  lastError?: string;
}

export interface SearchInput {
  query: string;
  projectKey: string;
  limit?: number;
}

export interface RememberInput extends ExplicitMemory {
  projectKey: string;
}

export interface MemoryCoordinator {
  prepareTurn(input: {
    prompt: string;
    projectKey: string;
    sessionId: string;
  }): Promise<TransientRecall>;
  enqueueTurn(input: SettledTurnSnapshot): Promise<EnqueueReceipt>;
  backfill(input?: { all?: boolean; maxSessions?: number }): Promise<{
    sessionsScanned: number;
    sessionsQueued: number;
    turnsFound: number;
    jobsEnqueued: number;
    jobsAlreadyQueued: number;
  }>;
  remember(input: RememberInput): Promise<MemoryRecord>;
  forget(selector: MemorySelector): Promise<void>;
  search(input: SearchInput): Promise<readonly SearchHit[]>;
  pending(input?: { all?: boolean }): Promise<readonly MemoryRecord[]>;
  editPending(selector: MemorySelector & { statement: string }): Promise<MemoryRecord>;
  approve(selector: MemorySelector): Promise<MemoryRecord>;
  reject(selector: MemorySelector): Promise<void>;
  rebuild(input?: { projectKey?: string; all?: boolean }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  status(): Promise<MemoryStatus>;
}

export interface ExtractorInput {
  projectKey: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  toolNames: readonly string[];
  recentDigest?: string;
}

export interface Extractor {
  extract(input: ExtractorInput, signal?: AbortSignal): Promise<readonly MemoryCandidate[]>;
}

export interface Embedder {
  embed(inputs: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}

export interface MemoryConfig {
  enabled: boolean;
  automaticCapture: boolean;
  databasePath: string;
  sourceRetentionMs: number;
  worker: {
    pollIntervalMs: number;
    leaseMs: number;
    maxAttempts: number;
    retryBaseMs: number;
    shutdownDrainMs: number;
  };
  extractor: {
    provider: string;
    model: string;
    thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    maxInputChars: number;
    maxOutputTokens: number;
    timeoutMs: number;
    extractorVersion: string;
    promptVersion: string;
  };
  embedding: {
    enabled: boolean;
    endpoint: string;
    model: string;
    timeoutMs: number;
  };
  recall: {
    maxMemories: number;
    maxChars: number;
    lexicalLimit: number;
    semanticLimit: number;
    semanticMinScore: number;
  };
}

export const DEFAULT_CONFIG: Omit<MemoryConfig, "databasePath"> = {
  enabled: true,
  automaticCapture: true,
  sourceRetentionMs: 7 * 24 * 60 * 60 * 1000,
  worker: {
    pollIntervalMs: 1_000,
    leaseMs: 60_000,
    maxAttempts: 5,
    retryBaseMs: 5_000,
    shutdownDrainMs: 1_500,
  },
  extractor: {
    provider: "openai",
    model: "gpt-5.6-luna",
    thinking: "high",
    maxInputChars: 12_000,
    maxOutputTokens: 1_000,
    timeoutMs: 30_000,
    extractorVersion: "v1",
    promptVersion: "v1",
  },
  embedding: {
    enabled: true,
    endpoint: "http://127.0.0.1:11434/api/embed",
    model: "nomic-embed-text",
    timeoutMs: 500,
  },
  recall: {
    maxMemories: 8,
    maxChars: 4_000,
    lexicalLimit: 32,
    semanticLimit: 32,
    semanticMinScore: 0.5,
  },
};
