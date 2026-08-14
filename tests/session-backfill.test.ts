import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanHistoricalSessions } from "../src/session-backfill.ts";

test("historical session scanning follows the active branch and excludes tool output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-sessions-"));
  try {
    const directory = join(root, "sessions", "--repo--");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "2025-01-01_session.jsonl"),
      [
        JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/repo" }),
        JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2025-01-01T00:00:01.000Z", message: { role: "user", content: "What language should we use?" } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2025-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "internal" }, { type: "text", text: "Use TypeScript." }, { type: "toolCall", name: "read" }] } }),
        JSON.stringify({ type: "message", id: "t1", parentId: "a1", timestamp: "2025-01-01T00:00:03.000Z", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "private tool output" }] } }),
        JSON.stringify({ type: "message", id: "u2", parentId: "t1", timestamp: "2025-01-01T00:01:01.000Z", message: { role: "user", content: [{ type: "text", text: "Remember that the release branch is stable." }] } }),
        JSON.stringify({ type: "message", id: "a2", parentId: "u2", timestamp: "2025-01-01T00:01:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "I will remember that." }] } }),
      ].join("\n") + "\n",
    );

    const sessions = await scanHistoricalSessions({
      sessionDirectory: join(root, "sessions"),
      projectKey: "git:/repo",
      resolveProjectKey: async (cwd) => `git:${cwd}`,
    });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.sessionId, "session-1");
    assert.equal(sessions[0]!.turns.length, 2);
    assert.deepEqual(sessions[0]!.turns[0], {
      sessionId: "session-1",
      projectKey: "git:/repo",
      branchId: "a2",
      sourceEntryIds: ["u1", "a1", "t1"],
      turnIndex: 0,
      userText: "What language should we use?",
      assistantText: "Use TypeScript.",
      toolNames: ["read"],
      capturedAt: Date.parse("2025-01-01T00:00:03.000Z"),
    });
    assert.equal(sessions[0]!.turns[1]!.assistantText, "I will remember that.");
    assert.equal(sessions[0]!.turns[0]!.assistantText.includes("private tool output"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
