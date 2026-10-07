# Contributing

Thanks for considering a contribution. This is a small server with a narrow scope: twelve MCP tools over TypeSafe's Jev, with question design kept in the server so every caller gets well-formed judgments.

## Development

```bash
npm install
npm run build
npm run typecheck
```

Node.js 22 or newer. TypeScript, ESM; runtime dependencies include the MCP SDK, TypeSafe SDK, Jev agent tools, and zod.

## Tests

```bash
npm test            # unit tests, offline
npm run test:e2e    # live tests; TYPESAFE_API_KEY and/or OPENAI_API_KEY
```

Unit tests cover the pure helpers in `src/lib.ts` and run everywhere, including CI. End-to-end tests spawn the built server over stdio and call the tools against the live TypeSafe API. They run in CI only when a `TYPESAFE_API_KEY` secret is configured, and locally only when the variable is set.

The OpenAI Decisions smoke also spawns the built server and exercises text, an inline image, and requirement checks. It runs only when `OPENAI_API_KEY` is set; otherwise it skips. Offline tests use a local HTTP stand-in to validate the native request and response contract across all twelve tools.

Both suites must pass before a pull request can merge. If you add behavior, add the test that would have caught its absence.

## Pull requests

- Keep changes small and scoped to one tool or one helper.
- New judgments belong in the tool questions and criteria, not in post-processing that second-guesses the model.
- Do not add tools without opening an issue first describing the judgment you want and why the existing twelve do not cover it.
- Update the README example for any tool whose arguments or results change.

## Notes

- The tools intentionally follow TypeSafe cookbook patterns. Link the relevant cookbook when you change a question design.
- Thresholds are parameters, not constants. Keep defaults in one place and document changes.
