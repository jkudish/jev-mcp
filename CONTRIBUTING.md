# Contributing

Thanks for considering a contribution. This is a small server with a narrow scope: twelve MCP judgment tools over a judgment provider (TypeSafe's Jev by default, or Cloudflare's Clef or OpenAI's Decisions API), with question design kept in the server so every caller gets well-formed judgments.

## Development

```bash
npm install
npm run build
npm run typecheck
```

Node.js 22 or newer. TypeScript, ESM; runtime dependencies include the MCP SDK, TypeSafe SDK, `@jkudish/discern-agent-tools`, and zod.

## Tests

```bash
npm test            # unit tests, offline
npm run test:e2e    # live API tests, requires TYPESAFE_API_KEY
DISCERN_PROVIDER=openai DISCERN_OPENAI_API_KEY=... npm run test:e2e   # same tests on OpenAI
DISCERN_PROVIDER=cloudflare DISCERN_MCP_MODEL=clef DISCERN_CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run test:e2e   # on Clef
```

Unit tests run offline everywhere, including CI. They cover the helpers in `src/lib.ts`, every tool against a mock provider, the tool-name and environment aliases, embedding, and the compatibility package. End-to-end tests spawn the built server over stdio and call the tools against a live provider: TypeSafe by default, or the provider you select with `DISCERN_PROVIDER`. They run in CI only when a `TYPESAFE_API_KEY` secret is configured, and locally only when the variable is set.

Both suites must pass before a pull request can merge. If you add behavior, add the test that would have caught its absence.

## Pull requests

- Keep changes small and scoped to one tool or one helper.
- New judgments belong in the tool questions and criteria, not in post-processing that second-guesses the model.
- Do not add tools without opening an issue first describing the judgment you want and why the existing twelve do not cover it.
- Update the README example for any tool whose arguments or results change.
- Provider transports, retries, and timeouts belong in `@jkudish/discern-agent-tools`, not here.
- Use `discern_*` tool names and `DISCERN_*` variables in code, tests, and docs. Add any new variable to `MCP_ENV_NAMES` in `src/env.ts`, and read it through `discernEnv()`, never `process.env` directly. The `jev_*` and `JEV_*` aliases exist only for 1.x compatibility and are covered by `test/aliases.test.mjs` and `test/compat.test.mjs`.
- The `@jkudish/jev-mcp` compatibility package lives in `compat/jev-mcp/`. Keep it a thin alias; it ships separately and is not part of the root package.

## Notes

- The tools intentionally follow TypeSafe cookbook patterns. Link the relevant cookbook when you change a question design.
- Thresholds are parameters, not constants. Keep defaults in one place and document changes.
