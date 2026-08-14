import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerPiMemory from "../src/pi-extension.ts";
import { SQLiteMemoryStore } from "../src/storage.ts";
import { resolveProjectKey } from "../src/project-key.ts";

interface RegisteredCommand {
  handler(args: string, ctx: any): Promise<void>;
}

test("recall is transient in provider context and absent from session entries", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-memory-project-"));
  await mkdir(join(home, ".pi", "agent", "memory"), { recursive: true });
  await writeFile(
    join(home, ".pi", "agent", "memory", "config.json"),
    JSON.stringify({
      databasePath: join(home, "memory.sqlite"),
      automaticCapture: false,
      embedding: { enabled: false },
    }),
  );

  const handlers = new Map<string, Function>();
  let command: RegisteredCommand | undefined;
  const pi = {
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerCommand(_name: string, definition: RegisteredCommand) {
      command = definition;
    },
  };
  registerPiMemory(pi as any);

  const sessionEntries: unknown[] = [];
  const notices: string[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => false,
      complete: async () => ({ content: [] }),
    },
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "leaf",
      getBranch: () => sessionEntries,
      getEntries: () => sessionEntries,
    },
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
  };

  process.env.PI_MEMORY_HOME = home;
  try {
    await handlers.get("session_start")!({}, ctx);
    assert.ok(command);
    await command!.handler("remember The project uses TypeScript --scope project", ctx);
    await handlers.get("before_agent_start")!({ prompt: "Which language does the project use?" }, ctx);

    const first = await handlers.get("context")!({ messages: [] }, ctx);
    const second = await handlers.get("context")!({ messages: [] }, ctx);
    assert.equal(first?.messages.filter((message: any) => message.customType === "pi-memory-recall").length, 1);
    assert.equal(second?.messages.filter((message: any) => message.customType === "pi-memory-recall").length, 1);
    assert.equal(sessionEntries.length, 0);
    assert.match(notices.join("\n"), /Remembered/);
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
    delete process.env.PI_MEMORY_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interactive review edits and approves a selected pending memory", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-memory-review-extension-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-memory-review-project-"));
  const databasePath = join(home, "memory.sqlite");
  const projectKey = await resolveProjectKey(cwd);
  await mkdir(join(home, ".pi", "agent", "memory"), { recursive: true });
  await writeFile(
    join(home, ".pi", "agent", "memory", "config.json"),
    JSON.stringify({ databasePath, embedding: { enabled: false } }),
  );
  const store = await SQLiteMemoryStore.open(databasePath);
  const now = Date.now();
  store.enqueueCapture({
    sourceId: "review-source",
    jobId: "review-job",
    sessionId: "review-session",
    projectKey,
    branchId: "branch",
    entryIds: [],
    sourceHash: "review-hash",
    payload: "{}",
    createdAt: now,
    retainUntil: now + 100_000,
    extractorVersion: "v1",
    promptVersion: "v1",
    extractorInput: { projectKey, sessionId: "review-session", userText: "", assistantText: "", toolNames: [] },
    requiresApproval: true,
  });
  store.claimNextJob("review-worker", now, 1_000);
  const candidate = {
    statement: "The project uses TypeScript",
    normalizedStatement: "the project uses typescript",
    kind: "project_fact" as const,
    confidence: 1,
    importance: 1,
    scopeCandidate: "project" as const,
  };
  store.markExtracted("review-job", "review-worker", [candidate], now + 1);
  const [pending] = store.commitJob("review-job", "review-worker", "review-source", [candidate], [], now + 2);
  store.close();

  const handlers = new Map<string, Function>();
  let command: RegisteredCommand | undefined;
  let reviewStep = 0;
  let editedPrompt = "";
  const pi = {
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    registerCommand(_name: string, definition: RegisteredCommand) {
      command = definition;
    },
  };
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    modelRegistry: {
      find: () => undefined,
      hasConfiguredAuth: () => false,
      complete: async () => ({ content: [] }),
    },
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "leaf",
      getBranch: () => [],
      getEntries: () => [],
    },
    ui: {
      notify() {},
      async editor(prompt: string) {
        editedPrompt = prompt;
        return "The project uses TypeScript and SQLite";
      },
      async custom(factory: Function) {
        let result: unknown;
        const component = factory(
          { requestRender() {} },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          {},
          (value: unknown) => { result = value; },
        );
        if (reviewStep++ === 0) component.handleInput("e");
        else {
          component.handleInput(" ");
          component.handleInput("\r");
        }
        return result;
      },
    },
  };

  process.env.PI_MEMORY_HOME = home;
  try {
    registerPiMemory(pi as any);
    await handlers.get("session_start")!({}, ctx);
    assert.ok(command);
    await command!.handler("review", ctx);
    assert.match(editedPrompt, /Edit pending project memory/);

    const reopened = await SQLiteMemoryStore.open(databasePath);
    const approved = reopened.getMemory(pending!.id);
    assert.equal(approved?.state, "active");
    assert.equal(approved?.statement, "The project uses TypeScript and SQLite");
    reopened.close();
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
    delete process.env.PI_MEMORY_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
