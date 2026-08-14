import test from "node:test";
import assert from "node:assert/strict";
import { MemoryReviewList, type ReviewListAction } from "../src/review-ui.ts";
import type { MemoryRecord } from "../src/types.ts";

const records: MemoryRecord[] = [
  {
    id: "one",
    scope: "project",
    scopeKey: "git:/repo",
    statement: "The project uses TypeScript",
    normalizedStatement: "the project uses typescript",
    kind: "project_fact",
    state: "pending",
    confidence: 1,
    importance: 1,
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
    contentHash: "hash-one",
  },
  {
    id: "two",
    scope: "global",
    scopeKey: "global",
    statement: "The user prefers concise answers",
    normalizedStatement: "the user prefers concise answers",
    kind: "preference",
    state: "pending",
    confidence: 1,
    importance: 1,
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
    contentHash: "hash-two",
  },
];

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("review list checks multiple memories and approves them as a batch", () => {
  let action: ReviewListAction | undefined;
  const list = new MemoryReviewList(records, theme, (next) => { action = next; });
  list.handleInput(" ");
  list.handleInput("\x1b[B");
  list.handleInput(" ");
  list.handleInput("\r");
  assert.deepEqual(action, { kind: "apply", decision: "approve", ids: ["one", "two"] });
});

test("review list edits the highlighted memory while preserving checked choices", () => {
  let action: ReviewListAction | undefined;
  const list = new MemoryReviewList(records, theme, (next) => { action = next; });
  list.handleInput(" ");
  list.handleInput("e");
  assert.deepEqual(action, { kind: "edit", id: "one", selectedIds: ["one"] });
});

test("review list supports select all, clear all, and cancel", () => {
  let action: ReviewListAction | undefined;
  const list = new MemoryReviewList(records, theme, (next) => { action = next; });
  list.handleInput("a");
  list.handleInput("n");
  list.handleInput("q");
  assert.deepEqual(action, { kind: "cancel" });
});
