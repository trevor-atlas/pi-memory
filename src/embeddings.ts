import type { Embedder } from "./types.ts";

function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function assertVectors(value: unknown, expected: number): number[][] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(`Ollama returned an invalid embedding batch of length ${String(value)}`);
  }
  const vectors: number[][] = [];
  let dimension: number | undefined;
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
      throw new Error("Ollama returned an invalid embedding vector");
    }
    dimension ??= raw.length;
    if (raw.length !== dimension) throw new Error("Ollama returned inconsistent embedding dimensions");
    vectors.push(raw as number[]);
  }
  return vectors;
}

export interface OllamaEmbedderOptions {
  endpoint: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class OllamaEmbedder implements Embedder {
  private readonly options: OllamaEmbedderOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaEmbedderOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(inputs: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (inputs.length === 0) return [];
    const response = await this.fetchImpl(this.options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.options.model, input: inputs }),
      signal: combinedSignal(signal, this.options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Ollama embedding request failed with HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { embeddings?: unknown };
    return assertVectors(payload.embeddings, inputs.length);
  }
}

export async function checkOllama(
  options: OllamaEmbedderOptions,
): Promise<{ model: string; count: number; dimension: number }> {
  const vectors = await new OllamaEmbedder(options).embed(["pi-memory health check"]);
  return {
    model: options.model,
    count: vectors.length,
    dimension: vectors[0]?.length ?? 0,
  };
}
