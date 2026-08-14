import test from "node:test";
import assert from "node:assert/strict";
import { OllamaEmbedder } from "../src/embeddings.ts";

test("Ollama adapter sends a batch and validates dimensions", async () => {
  let request: { model: string; input: string[] } | undefined;
  const embedder = new OllamaEmbedder({
    endpoint: "http://ollama.test/api/embed",
    model: "nomic-embed-text",
    timeoutMs: 100,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(String(init?.body)) as typeof request;
      return new Response(JSON.stringify({ embeddings: [[1, 0], [0, 1]] }), { status: 200 });
    },
  });

  const vectors = await embedder.embed(["one", "two"]);
  assert.deepEqual(request, { model: "nomic-embed-text", input: ["one", "two"] });
  assert.deepEqual(vectors, [[1, 0], [0, 1]]);
});

test("Ollama adapter reports unavailable endpoints", async () => {
  const embedder = new OllamaEmbedder({
    endpoint: "http://ollama.test/api/embed",
    model: "nomic-embed-text",
    timeoutMs: 100,
    fetchImpl: async () => new Response("no", { status: 503 }),
  });

  await assert.rejects(() => embedder.embed(["one"]), /HTTP 503/);
});
