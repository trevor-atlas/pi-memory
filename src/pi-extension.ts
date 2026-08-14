import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { loadMemoryConfig } from "./config.ts";
import { PersistentMemoryCoordinator } from "./coordinator.ts";
import { resolveProjectKey } from "./project-key.ts";
import { truncateText } from "./text.ts";
import type {
  MemoryCoordinator,
  SearchHit,
  SettledTurnSnapshot,
  TransientRecall,
} from "./types.ts";
import type { NestedModelRegistry } from "./extractor.ts";

const RECALL_CUSTOM_TYPE = "pi-memory-recall";
const MAX_ASSISTANT_CHARS = 8_000;
const MAX_USER_CHARS = 4_000;

interface ActiveTurn {
  prompt: string;
  turnIndex?: number;
  capturedAt: number;
  assistantParts: string[];
  toolNames: Set<string>;
  seenMessageKeys: Set<string>;
  recall?: TransientRecall;
}

interface Runtime {
  coordinator: PersistentMemoryCoordinator;
  projectKey: string;
  sessionId: string;
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: string; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  });
}

function toolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: string; name?: unknown };
    return item.type === "toolCall" && typeof item.name === "string" ? [item.name] : [];
  });
}

function messageKey(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const item = message as { role?: unknown; timestamp?: unknown; content?: unknown; toolCallId?: unknown };
  return JSON.stringify([item.role, item.timestamp, item.toolCallId, textParts(item.content), toolCallNames(item.content)]);
}

function addMessageToTurn(turn: ActiveTurn, message: unknown): void {
  if (!message || typeof message !== "object") return;
  const item = message as { role?: string; content?: unknown; toolName?: unknown };
  const key = messageKey(message);
  if (key && turn.seenMessageKeys.has(key)) return;
  if (key) turn.seenMessageKeys.add(key);

  if (item.role === "assistant") {
    turn.assistantParts.push(...textParts(item.content));
    for (const toolName of toolCallNames(item.content)) turn.toolNames.add(toolName);
  } else if (item.role === "toolResult" && typeof item.toolName === "string") {
    turn.toolNames.add(item.toolName);
  }
}

function branchEntryIds(ctx: ExtensionContext): string[] {
  try {
    return ctx.sessionManager
      .getBranch()
      .slice(-64)
      .map((entry) => (entry as { id?: string }).id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function branchDigest(ctx: ExtensionContext): string | undefined {
  try {
    const messages = ctx.sessionManager
      .getBranch()
      .slice(-12)
      .flatMap((entry) => {
        const item = entry as { type?: string; message?: { role?: string; content?: unknown } };
        if (item.type !== "message" || !item.message) return [];
        if (item.message.role !== "user" && item.message.role !== "assistant") return [];
        const text = textParts(item.message.content).join(" ").trim();
        return text ? [`${item.message.role}: ${text}`] : [];
      });
    return messages.length > 0 ? truncateText(messages.join("\n"), 3_000) : undefined;
  } catch {
    return undefined;
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function formatHit(hit: SearchHit): string {
  return `${hit.memory.id} [${hit.memory.scope}] ${hit.memory.statement}`;
}

function parseNonNegativeFlag(parts: readonly string[], name: string): number | undefined {
  const index = parts.findIndex((part) => part === name || part.startsWith(`${name}=`));
  if (index < 0) return undefined;
  const raw = parts[index]!.includes("=") ? parts[index]!.split("=", 2)[1] : parts[index + 1];
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : Number.NaN;
}

function snapshotTurn(
  turn: ActiveTurn,
  ctx: ExtensionContext,
  runtime: Runtime,
): SettledTurnSnapshot | undefined {
  const assistantText = truncateText(turn.assistantParts.join("\n").trim(), MAX_ASSISTANT_CHARS);
  const userText = truncateText(turn.prompt.trim(), MAX_USER_CHARS);
  if (!userText || !assistantText) return undefined;
  let branchId = "root";
  try {
    branchId = ctx.sessionManager.getLeafId() ?? "root";
  } catch {
    // In-memory test contexts may not expose a leaf.
  }
  return {
    sessionId: runtime.sessionId,
    projectKey: runtime.projectKey,
    branchId,
    sourceEntryIds: branchEntryIds(ctx),
    turnIndex: turn.turnIndex,
    userText,
    assistantText,
    toolNames: [...turn.toolNames].slice(0, 32),
    recentDigest: branchDigest(ctx),
    capturedAt: turn.capturedAt,
  };
}

async function closeRuntime(runtime: Runtime | undefined): Promise<void> {
  if (runtime) await runtime.coordinator.shutdown();
}

export default function registerPiMemory(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined;
  let activeTurn: ActiveTurn | undefined;
  let initialization: Promise<void> | undefined;

  const initialize = async (ctx: ExtensionContext): Promise<void> => {
    if (runtime) return;
    if (initialization) return initialization;
    initialization = (async () => {
      const projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
      const home = process.env.PI_MEMORY_HOME ?? homedir();
      const config = await loadMemoryConfig({
        cwd: ctx.cwd,
        home,
        projectTrusted,
      });
      const projectKey = await resolveProjectKey(ctx.cwd);
      const configuredSessionDirectory = (ctx.sessionManager as unknown as { getSessionDir?: () => string }).getSessionDir?.();
      const coordinator = await PersistentMemoryCoordinator.open({
        config,
        projectKey,
        sessionDirectory: configuredSessionDirectory || join(home, ".pi", "agent", "sessions"),
        modelRegistry: ctx.modelRegistry as unknown as NestedModelRegistry,
      });
      runtime = {
        coordinator,
        projectKey,
        sessionId: ctx.sessionManager.getSessionId() ?? "ephemeral",
      };
    })();
    try {
      await initialization;
    } catch (error) {
      initialization = undefined;
      throw error;
    }
  };

  const runtimeOrNotify = async (ctx: ExtensionCommandContext): Promise<Runtime | undefined> => {
    try {
      await initialize(ctx);
      return runtime;
    } catch (error) {
      notify(ctx, `Memory unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      return undefined;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      await closeRuntime(runtime);
      runtime = undefined;
      activeTurn = undefined;
      await initialize(ctx);
      notify(ctx, "Persistent memory ready", "info");
    } catch (error) {
      notify(ctx, `Persistent memory disabled: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!runtime) {
      try {
        await initialize(ctx);
      } catch {
        return;
      }
    }
    if (!runtime) return;
    activeTurn = {
      prompt: event.prompt,
      capturedAt: Date.now(),
      assistantParts: [],
      toolNames: new Set(),
      seenMessageKeys: new Set(),
    };
    try {
      activeTurn.recall = await runtime.coordinator.prepareTurn({
        prompt: event.prompt,
        projectKey: runtime.projectKey,
        sessionId: runtime.sessionId,
      });
    } catch {
      activeTurn.recall = undefined;
    }
  });

  pi.on("context", async (event) => {
    const recall = activeTurn?.recall;
    if (!recall || recall.hits.length === 0) return;
    const alreadyPresent = event.messages.some((message) => {
      const item = message as { role?: string; customType?: string };
      return item.role === "custom" && item.customType === RECALL_CUSTOM_TYPE;
    });
    if (alreadyPresent) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: RECALL_CUSTOM_TYPE,
          content: recall.block,
          display: false,
          details: { recallId: recall.id },
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("turn_start", (event) => {
    if (activeTurn) activeTurn.turnIndex = event.turnIndex;
  });

  pi.on("turn_end", async (event: TurnEndEvent) => {
    if (!activeTurn) return;
    addMessageToTurn(activeTurn, event.message);
    for (const result of event.toolResults ?? []) addMessageToTurn(activeTurn, result);
  });

  pi.on("agent_end", async (event) => {
    if (!activeTurn) return;
    for (const message of event.messages ?? []) addMessageToTurn(activeTurn, message);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!runtime || !activeTurn) return;
    const snapshot = snapshotTurn(activeTurn, ctx, runtime);
    activeTurn = undefined;
    if (!snapshot) return;
    try {
      await runtime.coordinator.enqueueTurn(snapshot);
    } catch {
      // Capture is optional and must never fail the completed user turn.
    }
  });

  pi.on("session_shutdown", async () => {
    const oldRuntime = runtime;
    runtime = undefined;
    activeTurn = undefined;
    initialization = undefined;
    await closeRuntime(oldRuntime);
  });

  pi.registerCommand("memory", {
    description: "Inspect and manage persistent memory",
    handler: async (args, ctx) => {
      const input = args.trim();
      const [subcommand, ...rest] = input.split(/\s+/u).filter(Boolean);
      const runtimeValue = await runtimeOrNotify(ctx);
      if (!runtimeValue) return;
      const coordinator = runtimeValue.coordinator;

      try {
        if (!subcommand || subcommand === "status") {
          const status = await coordinator.status();
          notify(
            ctx,
            `Memory: ${status.activeMemories} active (${status.projectMemories} project, ${status.globalMemories} global), ${status.pendingJobs} queued, ${status.failedJobs} failed${status.paused ? "; paused" : ""}`,
          );
          return;
        }

        if (subcommand === "pending") {
          const pending = await coordinator.pending({ all: rest.includes("--all") });
          notify(ctx, pending.length > 0 ? pending.map((record) => `${record.id} [${record.scope}] ${record.statement}`).join("\n") : "No pending memories");
          return;
        }

        if (subcommand === "search") {
          const query = rest.join(" ").trim();
          if (!query) {
            notify(ctx, "Usage: /memory search <query>", "warning");
            return;
          }
          const hits = await coordinator.search({ query, projectKey: runtimeValue.projectKey, limit: 10 });
          notify(ctx, hits.length > 0 ? hits.map(formatHit).join("\n") : "No matching memories");
          return;
        }

        if (subcommand === "remember") {
          const scopeIndex = rest.findIndex((part) => part === "--scope" || part.startsWith("--scope="));
          let scope: "project" | "global" | undefined;
          if (scopeIndex >= 0) {
            const flag = rest[scopeIndex];
            scope = flag.includes("=") ? flag.split("=", 2)[1] as "project" | "global" : rest[scopeIndex + 1] as "project" | "global";
          }
          if (scope !== "project" && scope !== "global") {
            notify(ctx, "Usage: /memory remember <text> --scope project|global", "warning");
            return;
          }
          const statement = rest
            .filter((part, index) => {
              if (part.startsWith("--scope=")) return false;
              if (index === scopeIndex) return false;
              return !(scopeIndex >= 0 && rest[scopeIndex] === "--scope" && index === scopeIndex + 1);
            })
            .join(" ")
            .trim();
          if (!statement) {
            notify(ctx, "Usage: /memory remember <text> --scope project|global", "warning");
            return;
          }
          const record = await coordinator.remember({ statement, scope, projectKey: runtimeValue.projectKey });
          notify(ctx, `Remembered ${record.id} [${record.scope}]`);
          return;
        }

        if (subcommand === "approve" || subcommand === "reject" || subcommand === "forget") {
          const id = rest.find((part) => part !== "--all");
          const all = rest.includes("--all");
          if (!id) {
            notify(ctx, `Usage: /memory ${subcommand} <id> [--all]`, "warning");
            return;
          }
          if (subcommand === "approve") {
            const record = await coordinator.approve({ id, all });
            notify(ctx, `Approved ${record.id}`);
          } else if (subcommand === "reject") {
            await coordinator.reject({ id, all });
            notify(ctx, `Rejected ${id}`);
          } else {
            await coordinator.forget({ id, all });
            notify(ctx, `Forgot ${id}`);
          }
          return;
        }

        if (subcommand === "backfill") {
          const maxSessions = parseNonNegativeFlag(rest, "--limit");
          if (Number.isNaN(maxSessions)) {
            notify(ctx, "Usage: /memory backfill [--all] [--limit N]", "warning");
            return;
          }
          const receipt = await coordinator.backfill({
            all: rest.includes("--all"),
            maxSessions,
          });
          notify(
            ctx,
            `Historical backfill scanned ${receipt.sessionsScanned} session${receipt.sessionsScanned === 1 ? "" : "s"}, queued ${receipt.sessionsQueued}, found ${receipt.turnsFound} turn${receipt.turnsFound === 1 ? "" : "s"}, added ${receipt.jobsEnqueued} new extraction job${receipt.jobsEnqueued === 1 ? "" : "s"}, and skipped ${receipt.jobsAlreadyQueued} already imported turn${receipt.jobsAlreadyQueued === 1 ? "" : "s"}. Review candidates with /memory pending.`, 
          );
          return;
        }

        if (subcommand === "rebuild") {
          await coordinator.rebuild(rest.includes("--all") ? { all: true } : { projectKey: runtimeValue.projectKey });
          notify(ctx, "Memory indexes rebuilt");
          return;
        }

        if (subcommand === "pause" || subcommand === "resume") {
          if (subcommand === "pause") await coordinator.pause();
          else await coordinator.resume();
          notify(ctx, `Memory ${subcommand}d`);
          return;
        }

        notify(ctx, "Usage: /memory status|pending|search|remember|approve|reject|forget|backfill|rebuild|pause|resume", "warning");
      } catch (error) {
        notify(ctx, `Memory command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

export { RECALL_CUSTOM_TYPE };
