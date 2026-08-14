import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packagePath = new URL("../package.json", import.meta.url);

test("repository package advertises a Pi extension", async () => {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    pi?: { extensions?: string[] };
  };

  assert.deepEqual(packageJson.pi?.extensions, ["./extensions/pi-memory.ts"]);
});
