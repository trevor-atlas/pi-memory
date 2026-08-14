import test from "node:test";
import assert from "node:assert/strict";
import { PersistentMemoryCoordinator, withDefaultConfig } from "../src/coordinator.ts";
import { SQLiteMemoryStore } from "../src/storage.ts";

test("shutdown fences a non-cooperative extractor before closing SQLite", async () => {
  const store = await SQLiteMemoryStore.open(":memory:");
  let release: (() => void) | undefined;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const coordinator = await PersistentMemoryCoordinator.open({
    config: withDefaultConfig(":memory:", {
      embedding: { enabled: false, endpoint: "", model: "", timeoutMs: 50 },
      worker: { pollIntervalMs: 1, leaseMs: 1_000, maxAttempts: 2, retryBaseMs: 1, shutdownDrainMs: 5 },
    }),
    store,
    extractor: {
      async extract() {
        signalStarted();
        return new Promise<readonly []>((resolve) => {
          release = () => resolve([]);
        });
      },
    },
  });
  await coordinator.enqueueTurn({
    sessionId: "s",
    projectKey: "git:/repo",
    branchId: "b",
    sourceEntryIds: ["e"],
    userText: "u",
    assistantText: "a",
    toolNames: [],
    capturedAt: Date.now(),
  });
  await started;
  await coordinator.shutdown();
  assert.ok(release);
  release!();
  await new Promise((resolve) => setTimeout(resolve, 10));
});
