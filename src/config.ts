import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { DEFAULT_CONFIG, type MemoryConfig } from "./types.ts";
import { withDefaultConfig } from "./coordinator.ts";

export interface ConfigLoadOptions {
  cwd: string;
  home?: string;
  projectTrusted?: boolean;
}

function defaultDatabasePath(home: string): string {
  return join(home, ".pi", "agent", "memory", "memory.sqlite");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function numberAt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function stringAt(value: unknown, fallback: string, maxLength = 2_000): string {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : fallback;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function thinkingAt(value: unknown): MemoryConfig["extractor"]["thinking"] {
  return typeof value === "string" && THINKING_LEVELS.has(value)
    ? value as MemoryConfig["extractor"]["thinking"]
    : DEFAULT_CONFIG.extractor.thinking;
}

export async function loadMemoryConfig(options: ConfigLoadOptions): Promise<MemoryConfig> {
  const home = options.home ?? homedir();
  const globalConfig = await readJson(join(home, ".pi", "agent", "memory", "config.json"));
  const projectConfig = options.projectTrusted
    ? await readJson(resolve(options.cwd, ".pi", "memory.json"))
    : {};
  const merged = {
    ...globalConfig,
    ...projectConfig,
    worker: {
      ...(globalConfig.worker as Record<string, unknown> | undefined),
      ...(projectConfig.worker as Record<string, unknown> | undefined),
    },
    extractor: {
      ...(globalConfig.extractor as Record<string, unknown> | undefined),
      ...(projectConfig.extractor as Record<string, unknown> | undefined),
    },
    embedding: {
      ...(globalConfig.embedding as Record<string, unknown> | undefined),
      ...(projectConfig.embedding as Record<string, unknown> | undefined),
    },
    recall: {
      ...(globalConfig.recall as Record<string, unknown> | undefined),
      ...(projectConfig.recall as Record<string, unknown> | undefined),
    },
  } as Record<string, any>;

  const config = withDefaultConfig(
    stringAt(merged.databasePath, defaultDatabasePath(home), 4_000),
    {
      enabled: merged.enabled !== false,
      automaticCapture: merged.automaticCapture !== false,
      sourceRetentionMs: numberAt(
        merged.sourceRetentionMs,
        DEFAULT_CONFIG.sourceRetentionMs,
        60_000,
        365 * 24 * 60 * 60 * 1000,
      ),
      worker: {
        pollIntervalMs: numberAt(merged.worker?.pollIntervalMs, DEFAULT_CONFIG.worker.pollIntervalMs, 50, 60_000),
        leaseMs: numberAt(merged.worker?.leaseMs, DEFAULT_CONFIG.worker.leaseMs, 1_000, 10 * 60_000),
        maxAttempts: numberAt(merged.worker?.maxAttempts, DEFAULT_CONFIG.worker.maxAttempts, 1, 20),
        retryBaseMs: numberAt(merged.worker?.retryBaseMs, DEFAULT_CONFIG.worker.retryBaseMs, 100, 15 * 60_000),
        shutdownDrainMs: numberAt(merged.worker?.shutdownDrainMs, DEFAULT_CONFIG.worker.shutdownDrainMs, 0, 30_000),
      },
      extractor: {
        provider: stringAt(merged.extractor?.provider, DEFAULT_CONFIG.extractor.provider),
        model: stringAt(merged.extractor?.model, DEFAULT_CONFIG.extractor.model),
        thinking: thinkingAt(merged.extractor?.thinking),
        maxInputChars: numberAt(merged.extractor?.maxInputChars, DEFAULT_CONFIG.extractor.maxInputChars, 500, 50_000),
        maxOutputTokens: numberAt(merged.extractor?.maxOutputTokens, DEFAULT_CONFIG.extractor.maxOutputTokens, 100, 8_000),
        timeoutMs: numberAt(merged.extractor?.timeoutMs, DEFAULT_CONFIG.extractor.timeoutMs, 1_000, 120_000),
        extractorVersion: stringAt(merged.extractor?.extractorVersion, DEFAULT_CONFIG.extractor.extractorVersion, 100),
        promptVersion: stringAt(merged.extractor?.promptVersion, DEFAULT_CONFIG.extractor.promptVersion, 100),
      },
      embedding: {
        enabled: merged.embedding?.enabled !== false,
        endpoint: stringAt(merged.embedding?.endpoint, DEFAULT_CONFIG.embedding.endpoint),
        model: stringAt(merged.embedding?.model, DEFAULT_CONFIG.embedding.model),
        timeoutMs: numberAt(merged.embedding?.timeoutMs, DEFAULT_CONFIG.embedding.timeoutMs, 50, 5_000),
      },
      recall: {
        maxMemories: numberAt(merged.recall?.maxMemories, DEFAULT_CONFIG.recall.maxMemories, 0, 50),
        maxChars: numberAt(merged.recall?.maxChars, DEFAULT_CONFIG.recall.maxChars, 300, 20_000),
        lexicalLimit: numberAt(merged.recall?.lexicalLimit, DEFAULT_CONFIG.recall.lexicalLimit, 1, 200),
        semanticLimit: numberAt(merged.recall?.semanticLimit, DEFAULT_CONFIG.recall.semanticLimit, 1, 200),
        semanticMinScore: numberAt(merged.recall?.semanticMinScore, DEFAULT_CONFIG.recall.semanticMinScore, 0, 1),
      },
    },
  );

  return config;
}
