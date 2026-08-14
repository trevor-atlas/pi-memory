import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMemoryConfig } from "../src/config.ts";

test("extractor quality policy is configurable", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-memory-config-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-memory-config-project-"));
  try {
    const configDirectory = join(home, ".pi", "agent", "memory");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "config.json"),
      JSON.stringify({
        extractor: {
          maxCandidates: 2,
          minConfidence: 0.95,
          minImportance: 0.85,
          requireEvidence: false,
          additionalInstructions: "Prefer workflow lessons.",
        },
      }),
    );
    const config = await loadMemoryConfig({
      home,
      cwd,
      projectTrusted: false,
    });

    assert.equal(config.extractor.maxCandidates, 2);
    assert.equal(config.extractor.minConfidence, 0.95);
    assert.equal(config.extractor.minImportance, 0.85);
    assert.equal(config.extractor.requireEvidence, false);
    assert.equal(config.extractor.additionalInstructions, "Prefer workflow lessons.");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
