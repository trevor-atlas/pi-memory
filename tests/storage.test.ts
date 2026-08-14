import test from "node:test";
import assert from "node:assert/strict";
import { SQLiteMemoryStore } from "../src/storage.ts";

test("SQLite migrations provide FTS5, scopes, duplicate safety, and deletion", async () => {
  const store = await SQLiteMemoryStore.open(":memory:");
  const now = 1_700_000_000_000;
  const projectKey = "git:/repo";

  const first = store.remember({
    scope: "project",
    scopeKey: projectKey,
    statement: "Use TypeScript for extension code",
    normalizedStatement: "use typescript for extension code",
    kind: "project_fact",
    confidence: 0.9,
    importance: 0.8,
    now,
  });
  const duplicate = store.remember({
    scope: "project",
    scopeKey: projectKey,
    statement: "Use TypeScript for extension code",
    normalizedStatement: "use typescript for extension code",
    kind: "project_fact",
    confidence: 1,
    importance: 1,
    now: now + 1,
  });

  assert.equal(first.id, duplicate.id);
  assert.equal(store.searchLexical("TypeScript", projectKey, 10, now + 2).length, 1);
  assert.equal(store.status().activeMemories, 1);

  store.forget(first.id, now + 3);
  assert.equal(store.searchLexical("TypeScript", projectKey, 10, now + 4).length, 0);
  assert.equal(store.status().activeMemories, 0);
  store.close();
});

test("capture jobs are durable, leased, recoverable, and idempotent", async () => {
  const store = await SQLiteMemoryStore.open(":memory:");
  const now = 1_700_000_000_000;
  const source = {
    sourceId: "source-1",
    sessionId: "session-1",
    projectKey: "git:/repo",
    branchId: "branch-1",
    entryIds: ["entry-1"],
    sourceHash: "hash-1",
    payload: "{}",
    createdAt: now,
    retainUntil: now + 10_000,
    extractorVersion: "extractor-v1",
    promptVersion: "prompt-v1",
    extractorInput: {
      projectKey: "git:/repo",
      sessionId: "session-1",
      userText: "What do we use?",
      assistantText: "TypeScript",
      toolNames: [],
    },
  };

  assert.equal(store.enqueueCapture({ ...source, jobId: "job-1" }).inserted, true);
  assert.equal(store.enqueueCapture({ ...source, jobId: "job-1" }).inserted, false);

  const claimed = store.claimNextJob("worker-1", now, 100);
  assert.equal(claimed?.jobId, "job-1");
  assert.equal(store.claimNextJob("worker-2", now + 50, 100), undefined);
  assert.equal(store.recoverExpiredLeases(now + 101), 1);
  const reclaimed = store.claimNextJob("worker-2", now + 101, 100);
  assert.equal(reclaimed?.jobId, "job-1");

  const candidates = [
    {
      statement: "The project uses TypeScript",
      normalizedStatement: "the project uses typescript",
      kind: "project_fact" as const,
      confidence: 1,
      importance: 0.8,
      scopeCandidate: "project" as const,
    },
  ];
  assert.throws(
    () => store.commitJob("job-1", "worker-1", "source-1", candidates, [], now + 102),
    /lease lost/,
  );
  assert.equal(store.status().activeMemories, 0);
  store.markExtracted("job-1", "worker-2", candidates, now + 102);
  const records = store.commitJob("job-1", "worker-2", "source-1", candidates, [], now + 103);
  assert.equal(records.length, 1);
  assert.equal(store.status().activeMemories, 1);

  store.rebuildFts();
  assert.equal(store.searchLexical("TypeScript", "git:/repo", 10, now + 104).length, 1);
  assert.equal(
    store.enqueueCapture({ ...source, jobId: "job-2", extractorVersion: "extractor-v2", promptVersion: "prompt-v2" }).inserted,
    true,
  );
  store.forget(records[0]!.id, now + 105);
  const secondJob = store.claimNextJob("worker-3", now + 105, 1000);
  assert.equal(secondJob?.jobId, "job-2");
  store.markExtracted("job-2", "worker-3", candidates, now + 106);
  assert.deepEqual(store.commitJob("job-2", "worker-3", "source-1", candidates, [], now + 107), []);
  assert.equal(store.status().activeMemories, 0);
  store.close();
});

test("historical project candidates stay pending until approval", async () => {
  const store = await SQLiteMemoryStore.open(":memory:");
  const now = 1_700_000_000_000;
  store.enqueueCapture({
    sourceId: "source-history",
    jobId: "job-history",
    sessionId: "s",
    projectKey: "git:/repo",
    branchId: "b",
    entryIds: [],
    sourceHash: "h",
    payload: "{}",
    createdAt: now,
    retainUntil: now + 1000,
    extractorVersion: "v1",
    promptVersion: "v1",
    extractorInput: { projectKey: "git:/repo", sessionId: "s", userText: "", assistantText: "", toolNames: [] },
    requiresApproval: true,
  });
  store.claimNextJob("w", now, 1000);
  const candidate = {
    statement: "The project uses TypeScript",
    normalizedStatement: "the project uses typescript",
    kind: "project_fact" as const,
    confidence: 1,
    importance: 1,
    scopeCandidate: "project" as const,
  };
  store.markExtracted("job-history", "w", [candidate], now + 1);
  const [record] = store.commitJob("job-history", "w", "source-history", [candidate], [], now + 2);
  assert.equal(record?.state, "pending");
  assert.equal(store.searchLexical("TypeScript", "git:/repo", 10, now + 3).length, 0);
  const approved = store.approve(record!.id, now + 4);
  assert.equal(approved.state, "active");
  assert.equal(store.searchLexical("TypeScript", "git:/repo", 10, now + 5).length, 1);
  store.close();
});

test("global extracted candidates stay pending until approval", async () => {
  const store = await SQLiteMemoryStore.open(":memory:");
  const now = 1_700_000_000_000;
  store.enqueueCapture({
    sourceId: "source-global",
    jobId: "job-global",
    sessionId: "s",
    projectKey: "git:/repo",
    branchId: "b",
    entryIds: [],
    sourceHash: "h",
    payload: "{}",
    createdAt: now,
    retainUntil: now + 1000,
    extractorVersion: "v1",
    promptVersion: "v1",
    extractorInput: { projectKey: "git:/repo", sessionId: "s", userText: "", assistantText: "", toolNames: [] },
  });
  store.claimNextJob("w", now, 1000);
  const candidate = {
    statement: "The user prefers dark mode",
    normalizedStatement: "the user prefers dark mode",
    kind: "preference" as const,
    confidence: 1,
    importance: 1,
    scopeCandidate: "global" as const,
  };
  store.markExtracted("job-global", "w", [candidate], now + 1);
  const [record] = store.commitJob("job-global", "w", "source-global", [candidate], [], now + 2);
  assert.equal(record?.state, "pending");
  assert.equal(store.searchLexical("dark mode", "git:/repo", 10, now + 3).length, 0);
  const approved = store.approve(record!.id, now + 4);
  assert.equal(approved.state, "active");
  assert.equal(store.searchLexical("dark mode", "git:/repo", 10, now + 5).length, 1);
  store.close();
});
