import { randomUUID } from "node:crypto";
import { extractorPrompt, parseExtractorResponse } from "./validation.ts";
import type { Extractor, ExtractorInput, MemoryConfig } from "./types.ts";

export interface NestedModelRegistry {
  find(provider: string, modelId: string): unknown;
  hasConfiguredAuth(model: unknown): boolean;
  complete(
    model: unknown,
    context: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ content: readonly { type: string; text?: string }[] }>;
}

function combineSignals(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  if (!parent) return timeout;
  return AbortSignal.any([parent, timeout]);
}

export class PiRemoteExtractor implements Extractor {
  private readonly registry: NestedModelRegistry;
  private readonly config: MemoryConfig["extractor"];

  constructor(registry: NestedModelRegistry, config: MemoryConfig["extractor"]) {
    this.registry = registry;
    this.config = config;
  }

  async extract(input: ExtractorInput, signal?: AbortSignal) {
    const model = this.registry.find(this.config.provider, this.config.model);
    if (!model) throw new Error(`Extractor model not found: ${this.config.provider}/${this.config.model}`);
    if (!this.registry.hasConfiguredAuth(model)) {
      throw new Error(`Extractor has no configured auth: ${this.config.provider}/${this.config.model}`);
    }

    const requestText = extractorPrompt(input, this.config.additionalInstructions).slice(0, this.config.maxInputChars);
    const response = await this.registry.complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: requestText }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        reasoningEffort: this.config.thinking,
        maxTokens: this.config.maxOutputTokens,
        cacheRetention: "none",
        sessionId: `pi-memory-extractor-${randomUUID()}`,
        signal: combineSignals(signal, this.config.timeoutMs),
      },
    );

    const text = response.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    return parseExtractorResponse(text, {
      maxCandidates: this.config.maxCandidates,
      minConfidence: this.config.minConfidence,
      minImportance: this.config.minImportance,
      requireEvidence: this.config.requireEvidence,
    });
  }
}

export class DisabledExtractor implements Extractor {
  async extract(): Promise<readonly []> {
    return [];
  }
}
