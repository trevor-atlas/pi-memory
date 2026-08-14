import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PersistentMemoryCoordinator, withDefaultConfig } from "../src/coordinator.ts";
import { resolveProjectKey } from "../src/project-key.ts";
import { SQLiteMemoryStore } from "../src/storage.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for historical extraction");
}

test("backfill queues historical turns as reviewable project candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-backfill-"));
  const project = join(root, "project");
  const sessionDirectory = join(root, "sessions");
  await mkdir(project, { recursive: true });
  await mkdir(sessionDirectory, { recursive: true });
  const writeSession = async (path: string, sessionId: string, userId: string, assistantId: string, userText: string) => {
    await writeFile(
      path,
      [
        JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2025-01-01T00:00:00.000Z", cwd: project }),
        JSON.stringify({ type: "message", id: userId, parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: userText } }),
        JSON.stringify({ type: "message", id: assistantId, parentId: userId, timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Use TypeScript." }] } }),
      ].join("\n") + "\n",
    );
  };
  await writeSession(join(sessionDirectory, "session.jsonl"), "historical-session", "u1", "a1", "What should we use?");
  await writeSession(join(sessionDirectory, "z-session.jsonl"), "historical-session-2", "u2", "a2", "What should we use next?");

  const store = await SQLiteMemoryStore.open(":memory:");
  const projectKey = await resolveProjectKey(project);
  const coordinator = await PersistentMemoryCoordinator.open({
    config: withDefaultConfig(":memory:", {
      embedding: { enabled: false, endpoint: "", model: "", timeoutMs: 50 },
      worker: { pollIntervalMs: 1, leaseMs: 1_000, maxAttempts: 2, retryBaseMs: 1, shutdownDrainMs: 50 },
    }),
    projectKey,
    sessionDirectory,
    store,
    extractor: {
      async extract() {
        return [{
          statement: "The project uses TypeScript",
          kind: "project_fact",
          confidence: 1,
          importance: 1,
          evidence: "The user confirmed the project convention",
          scopeCandidate: "project",
        }];
      },
    },
  });

  try {
    const first = await coordinator.backfill({ maxSessions: 1 });
    assert.deepEqual(first, { sessionsScanned: 1, sessionsQueued: 1, turnsFound: 1, jobsEnqueued: 1, jobsAlreadyQueued: 0 });
    await waitFor(() => store.status().pendingMemories === 1);

    const [pending] = await coordinator.pending();
    assert.equal(pending?.state, "pending");
    assert.equal(pending?.statement, "The project uses TypeScript");
    await coordinator.approve({ id: pending!.id });
    assert.equal(store.status().activeMemories, 1);

    const second = await coordinator.backfill({ maxSessions: 1 });
    assert.deepEqual(second, { sessionsScanned: 2, sessionsQueued: 1, turnsFound: 2, jobsEnqueued: 1, jobsAlreadyQueued: 1 });
  } finally {
    await coordinator.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
