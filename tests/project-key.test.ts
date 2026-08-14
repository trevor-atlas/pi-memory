import test from "node:test";
import assert from "node:assert/strict";
import { GitProjectResolver } from "../src/project-key.ts";

test("project identity prefers the canonical git root", async () => {
  const resolver = new GitProjectResolver({
    async run() {
      return "/tmp/project/../project";
    },
  });

  assert.equal(await resolver.resolve("/tmp/project/packages/app"), "git:/tmp/project");
});

test("project identity falls back to a normalized cwd outside git", async () => {
  const resolver = new GitProjectResolver({
    async run() {
      return undefined;
    },
  });

  assert.equal(await resolver.resolve("/tmp/project/./packages/../app"), "cwd:/tmp/project/app");
});
