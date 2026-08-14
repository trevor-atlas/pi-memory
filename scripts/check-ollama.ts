import { checkOllama } from "../src/embeddings.ts";

const result = await checkOllama({
  endpoint: process.env.PI_MEMORY_OLLAMA_ENDPOINT ?? "http://127.0.0.1:11434/api/embed",
  model: process.env.PI_MEMORY_OLLAMA_MODEL ?? "nomic-embed-text",
  timeoutMs: 2_000,
});
console.log(JSON.stringify(result));
