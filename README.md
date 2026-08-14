# pi-memory

A Hermes-inspired persistent-memory extension for Pi.

The package is intentionally local-first: durable facts are stored in a user-level SQLite
 database, lexical retrieval uses SQLite FTS5, and semantic retrieval can use the local Ollama
 `nomic-embed-text` model. Automatic extraction is project-scoped; approved global preferences are
 kept separate.

## Local iteration

Read [`.ai/ITERATING.md`](.ai/ITERATING.md) for the verified development loop. The short version is:

```bash
just verify
just load-check
```

`just ollama-check` exercises the optional local embedding dependency. The extension reads optional
JSON configuration from `~/.pi/agent/memory/config.json` and trusted project overrides from
`.pi/memory.json`; the default database is `~/.pi/agent/memory/memory.sqlite`.

Commands include `/memory status`, `/memory pending`, `/memory search <query>`,
`/memory remember <text> --scope project|global`, `/memory approve <id>`, `/memory reject <id>`,
`/memory forget <id>`, `/memory rebuild [--all]`, `/memory pause`, and `/memory resume`.

## Safety status

The extension is enabled as a global Pi package from this repository. Lifecycle, persistence,
redaction, transient-context, lease-fencing, shutdown, and failure-mode tests pass. Automatic
capture is best-effort and does not block completed turns; it does not backfill existing Pi
sessions by default.
