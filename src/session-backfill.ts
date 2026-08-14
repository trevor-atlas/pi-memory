import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { SettledTurnSnapshot } from "./types.ts";

interface SessionEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

interface SessionHeader {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
}

export interface HistoricalSession {
  path: string;
  sessionId: string;
  cwd: string;
  projectKey: string;
  turns: readonly SettledTurnSnapshot[];
}

export interface ScanHistoricalSessionsOptions {
  sessionDirectory: string;
  projectKey?: string;
  maxSessions?: number;
  resolveProjectKey: (cwd: string) => Promise<string>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestampMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  });
}

function toolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: unknown; name?: unknown };
    return item.type === "toolCall" && typeof item.name === "string" ? [item.name] : [];
  });
}

async function listJsonlFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files.sort();
}

async function readSession(path: string): Promise<{
  header: SessionHeader;
  entries: Map<string, SessionEntry>;
  lastEntryId: string;
} | undefined> {
  const entries = new Map<string, SessionEntry>();
  let header: SessionHeader | undefined;
  let lastEntryId = "";
  let fallbackTimestamp = Date.now();

  let stream;
  try {
    stream = createReadStream(path, { encoding: "utf8" });
  } catch {
    return undefined;
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const record = value as SessionHeader & SessionEntry;
      if (!header && record.type === "session") {
        header = record;
        fallbackTimestamp = timestampMs(record.timestamp, fallbackTimestamp);
        continue;
      }
      const id = asString(record.id);
      if (!id) continue;
      entries.set(id, record);
      lastEntryId = id;
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }

  if (!header || !asString(header.cwd) || !lastEntryId) return undefined;
  return { header, entries, lastEntryId };
}

function buildTurns(
  sessionId: string,
  projectKey: string,
  branchId: string,
  cwd: string,
  headerTimestamp: number,
  entries: Map<string, SessionEntry>,
  lastEntryId: string,
): HistoricalSession["turns"] {
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let currentId = lastEntryId;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const entry = entries.get(currentId);
    if (!entry) break;
    path.push(entry);
    currentId = asString(entry.parentId);
  }
  path.reverse();

  const turns: SettledTurnSnapshot[] = [];
  let current:
    | {
        userText: string;
        assistantParts: string[];
        toolNames: Set<string>;
        sourceEntryIds: string[];
        capturedAt: number;
      }
    | undefined;

  const finish = (): void => {
    if (!current) return;
    const assistantText = current.assistantParts.join("\n").trim();
    if (current.userText.trim() && assistantText) {
      turns.push({
        sessionId,
        projectKey,
        branchId,
        sourceEntryIds: current.sourceEntryIds.slice(0, 64),
        turnIndex: turns.length,
        userText: current.userText.trim(),
        assistantText,
        toolNames: [...current.toolNames].slice(0, 32),
        capturedAt: current.capturedAt,
      });
    }
    current = undefined;
  };

  for (const entry of path) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as {
      role?: unknown;
      content?: unknown;
      toolName?: unknown;
      timestamp?: unknown;
    };
    const role = asString(message.role);
    const entryId = asString(entry.id);
    const messageTimestamp = timestampMs(message.timestamp ?? entry.timestamp, headerTimestamp);

    if (role === "user") {
      finish();
      const userText = textParts(message.content).join("\n").trim();
      if (!userText) continue;
      current = {
        userText,
        assistantParts: [],
        toolNames: new Set(),
        sourceEntryIds: entryId ? [entryId] : [],
        capturedAt: messageTimestamp,
      };
      continue;
    }

    if (!current) continue;
    if (entryId) current.sourceEntryIds.push(entryId);
    current.capturedAt = Math.max(current.capturedAt, messageTimestamp);
    if (role === "assistant") {
      current.assistantParts.push(...textParts(message.content));
      for (const name of toolCallNames(message.content)) current.toolNames.add(name);
    } else if (role === "toolResult" && typeof message.toolName === "string") {
      current.toolNames.add(message.toolName);
    }
  }
  finish();
  return turns;
}

export async function scanHistoricalSessions(
  options: ScanHistoricalSessionsOptions,
): Promise<readonly HistoricalSession[]> {
  const files = await listJsonlFiles(options.sessionDirectory);
  const sessions: HistoricalSession[] = [];
  const maxSessions = options.maxSessions === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(options.maxSessions));

  for (const path of files) {
    if (sessions.length >= maxSessions) break;
    const parsed = await readSession(path);
    if (!parsed) continue;
    const cwd = asString(parsed.header.cwd);
    let projectKey: string;
    try {
      projectKey = await options.resolveProjectKey(cwd);
    } catch {
      continue;
    }
    if (options.projectKey && projectKey !== options.projectKey) continue;

    const headerTimestamp = timestampMs(parsed.header.timestamp, Date.now());
    const sessionId = asString(parsed.header.id) || basename(path, ".jsonl");
    const turns = buildTurns(
      sessionId,
      projectKey,
      parsed.lastEntryId,
      cwd,
      headerTimestamp,
      parsed.entries,
      parsed.lastEntryId,
    );
    sessions.push({ path, sessionId, cwd, projectKey, turns });
  }
  return sessions;
}
