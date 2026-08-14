import test from "node:test";
import assert from "node:assert/strict";
import { semanticCandidates } from "../src/recall.ts";
import type { MemoryRecord } from "../src/types.ts";

function memory(id: string, statement: string): MemoryRecord {
  return {
    id,
    scope: "project",
    scopeKey: "cwd:/repo",
    statement,
    normalizedStatement: statement.toLowerCase(),
    kind: "project_fact",
    state: "active",
    confidence: 1,
    importance: 1,
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
    contentHash: id,
  };
}

test("semantic recall omits weakly related memories", () => {
  const hits = semanticCandidates(
    [1, 0],
    [
      { memory: memory("relevant", "The project uses orange branding"), vector: [0.8, 0.6] },
      { memory: memory("unrelated", "Lease fencing passed review"), vector: [0.424, 0.906] },
    ],
    10,
    0.5,
  );

  assert.deepEqual(hits.map((hit) => hit.memory.id), ["relevant"]);
});
