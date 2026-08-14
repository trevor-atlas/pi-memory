set shell := ["bash", "-euo", "pipefail", "-c"]

# Run the repository's fast unit and integration tests.
test:
    npm test

# Check that the extension entrypoint parses as TypeScript.
check:
    npm run check

# Verify the extension factory can be imported without starting a session.
load-check:
    npm run load-check

# Run all local verification that does not require a remote extractor.
verify: check test

# Exercise the real Ollama embed endpoint when it is available.
ollama-check:
    node --experimental-strip-types scripts/check-ollama.ts
