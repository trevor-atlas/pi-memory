import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerPiMemory from "../src/pi-extension.ts";

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
