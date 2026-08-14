import test from "node:test";
import assert from "node:assert/strict";
import { MemoryWorker } from "../src/worker.ts";
import { SQLiteMemoryStore } from "../src/storage.ts";
import { withDefaultConfig } from "../src/coordinator.ts";

test("worker dead-letters an extractor failure without throwing into the agent", async () => {
  const store = await SQLiteMemoryStore.open(":memory:");
  const now = 1_700_000_000_000;
  store.enqueueCapture({
    sourceId: "source-failure",
    jobId: "job-failure",
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
    extractorInput: { projectKey: "git:/repo", sessionId: "s", userText: "u", assistantText: "a", toolNames: [] },
  });

  const worker = new MemoryWorker({
    store,
    clock: { now: () => now },
    extractor: {
      async extract() {
        throw new Error("remote extractor unavailable");
      },
    },
    config: withDefaultConfig(":memory:", {
      embedding: { enabled: false, endpoint: "", model: "", timeoutMs: 50 },
      worker: { pollIntervalMs: 10, leaseMs: 1000, maxAttempts: 1, retryBaseMs: 1, shutdownDrainMs: 10 },
    }),
  });

  assert.equal(await worker.processOne(), true);
  assert.equal((await store.status()).failedJobs, 1);
  await worker.stop();
  store.close();
});
