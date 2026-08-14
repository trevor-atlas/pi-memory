# Iterating on pi-memory

How to run and verify the Pi persistent-memory extension. Produced by the `iteration-setup` skill on
2026-08-14. Re-run that skill if the package entrypoints or run story drift.

## Components

| Name | Type | Entry | Purpose | Depends on |
|------|------|-------|---------|------------|
| pi-memory package | Node/TypeScript Pi package | `extensions/pi-memory.ts` | Registers the Pi lifecycle hooks and `/memory` commands | Node >=24; SQLite is provided by `node:sqlite` |
| memory database | Local embedded datastore | `~/.pi/agent/memory/memory.sqlite` (configurable) | Stores sources, capture jobs, memories, FTS5 rows, and embeddings | SQLite/FTS5 in Node |
| Ollama embedder | Optional local HTTP dependency | `http://127.0.0.1:11434/api/embed` | Creates `nomic-embed-text` vectors for semantic recall | Ollama app and model |
| remote extractor | Optional nested Pi model call | Pi `ctx.modelRegistry.complete()` | Extracts bounded durable-fact candidates asynchronously | Configured Pi provider/model |

There are no HubSpot RPC, worker, frontend, Kafka, TQ2, or deploy-config components in this repository.

## Dependencies & startup order

The package has no long-lived process outside a Pi session. Pi loads the extension factory first; the
extension opens SQLite only at `session_start`. A worker is started only after a session exists. The
worker can use FTS5 without Ollama and treats the remote extractor/Ollama as optional failure-prone
adapters.

For a local end-to-end probe: start Ollama and confirm `nomic-embed-text`, then run Pi with the
extension. No separate daemon or queue is required.

## Running each component

| What | Recipe | Raw command |
|------|--------|-------------|
| Unit/integration tests | `just test` | `npm test` |
| TypeScript entrypoint parse check | `just check` | `npm run check` |
| Import the extension factory | `just load-check` | `npm run load-check` |
| Full local verification | `just verify` | `npm run check && npm test` |
| Ollama dependency probe | `just ollama-check` | `node --experimental-strip-types scripts/check-ollama.ts` |
| Pi smoke test | `pi -p --no-session -e ./extensions/pi-memory.ts ...` | Use an extension command so no model turn is needed |

`just` was not installed during setup, so the raw npm commands above are the verified loop.

## Local infrastructure

- **Node:** Use the repository's Node >=24 runtime. Tests use Node's built-in test runner and native
  TypeScript type stripping; no compile step or native npm SQLite dependency is required.
- **SQLite:** `node:sqlite` is opened by the coordinator with WAL, foreign keys, busy timeout, and
  numbered migrations.
- **Ollama:** Optional for lexical-only tests. Run `ollama serve`/the Ollama app, pull
  `nomic-embed-text`, then use `just ollama-check`. Query embedding has a strict timeout and falls
  back to lexical search.
- **Extractor:** Optional for unit tests; fake extractors are used for deterministic tests. A real
  Pi session uses the configured nested model registry and never blocks the user's main turn on a
  failed extraction.

## Making and verifying a change

This package is loaded by Pi through its TypeScript entrypoint, so source changes are picked up by a
new process or `/reload` in an interactive session. SQLite migrations are applied at session start;
never edit an existing migration after it has been used.

| Change to... | Pick it up by | Confirm it worked by |
|--------------|---------------|----------------------|
| Domain/storage TypeScript | `just verify`, then restart Pi or `/reload` | Tests pass and `/memory status` reports the new schema/state |
| Extension lifecycle wiring | `just load-check`, then restart Pi or `/reload` | `pi -p --no-session -e ./extensions/pi-memory.ts` handles `/memory status` without a model call |
| SQLite schema | Add a numbered migration, run `just test` with a fresh temp DB | Migration tests and `PRAGMA integrity_check` pass |
| Ollama adapter | Start/restart Ollama as needed | `just ollama-check` reports model/dimension and adapter tests cover timeout fallback |
| Package manifest | Run `just check load-check` | Pi smoke test loads the package without a module-resolution error |

## Testing

- `just verify` is the default local gate and does not require network access or credentials.
- Tests use temporary SQLite databases, fake clocks, fake extractors, fake embedders, and fake Pi
  lifecycle contexts. They cover project/global scope, redaction, FTS5, leases/retries,
  idempotency, transient context injection, and deletion.
- `just ollama-check` is an opt-in real-boundary probe and should fail clearly if Ollama is not
  reachable; it is not part of the offline test gate.
- The package deliberately does not backfill existing Pi session files by default.
- Global installation is registered as the local package path `../../src/pi-memory` in
  `~/.pi/agent/settings.json`; remove it with `pi remove /Users/tatlas/src/pi-memory` if needed.

## Gotchas

- Do not use `pi.sendMessage()` or `appendCustomMessageEntry()` for dynamic recall: both persist or
  otherwise alter session state. Recall is added as one transient message by the `context` hook.
- `context` runs before every provider call, including tool loops. Cache recall per user turn and
  assert one injected block per turn.
- `agent_settled` has no message payload. Snapshot finalized data at `turn_end`/`agent_end`, then
  enqueue after settlement.
- Session files are trees; physical JSONL order and turn number are not sufficient idempotency keys.
- Sanitized source snapshots are still sensitive retention. Keep their retention policy explicit and
  never include recalled memory in extraction input.
- If SQLite is locked, the worker retries; a memory failure must not fail the main Pi turn.

## Pointers

- Launcher recipes: `Justfile`
- Package metadata: `package.json`
- Extension entrypoint: `extensions/pi-memory.ts`
- Source modules: `src/`
- Tests: `tests/`
