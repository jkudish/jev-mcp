# Contributing

Thanks for considering a contribution. This is a small server with a narrow scope: purpose-built MCP tools over TypeSafe's Jev, with question design kept in the server so every caller gets well-formed judgments.

## Development

```bash
npm install
npm run build
npm run typecheck
```

Node.js 20 or newer. TypeScript, ESM, no runtime dependencies beyond the MCP SDK, the TypeSafe SDK, and zod.

## Tests

```bash
npm test            # unit tests, offline
npm run test:e2e    # live API tests, requires TYPESAFE_API_KEY
```

Unit tests cover the pure helpers in `src/lib.ts` and run everywhere, including CI. End-to-end tests spawn the built server over stdio and call the tools against the live TypeSafe API. They run in CI only when a `TYPESAFE_API_KEY` secret is configured, and locally only when the variable is set.

Both suites must pass before a pull request can merge. If you add behavior, add the test that would have caught its absence.

## Pull requests

- Keep changes small and scoped to one tool or one helper.
- New judgments belong in the tool questions and criteria, not in post-processing that second-guesses the model.
- Do not add tools without opening an issue first describing the judgment you want and why the existing tools do not cover it.
- Update the README example for any tool whose arguments or results change.

## Notes

- Verify, screen, and find follow TypeSafe cookbook patterns; the coding-loop tools follow the burnigtm/jev-mcp recipes (MIT). Link the relevant cookbook or recipe when you change a question design.
- Thresholds are parameters, not constants. Keep defaults in one place and document changes.
