---
name: releasing
description: >
  Releases this package to npm and GitHub. Use when cutting a new version of
  @jkudish/discern-mcp (or its @jkudish/jev-mcp compatibility package),
  bumping versions, writing changelogs, publishing to npm, tagging releases,
  or troubleshooting a publish that did not go as expected.
---

# Releasing @jkudish/discern-mcp

Two destinations, one gate. The agent stages the npm release; only Joey can
approve it (passkey, npmjs.com Staged Packages tab). Everything else is
mechanical and exact.

This repository publishes two packages:

- `@jkudish/discern-mcp`: the root package. This is the real server.
- `@jkudish/jev-mcp`: the 1.x compatibility package in `compat/jev-mcp/`. It
  depends on `@jkudish/discern-mcp` and only sets `DISCERN_TOOL_NAMES=jev`.
  Release it only when its own files or its dependency range change, and
  always after the discern-mcp version it depends on is live. Run its steps
  from `compat/jev-mcp/`. It has no lockfile and no build.

## Sequence

1. Bump `version` in package.json. Add a `## <version>` section to CHANGELOG.md
   with user-visible changes only. No internal task ids, no private names.
2. Sync the lockfile: `npm install --package-lock-only`. A name or version
   mismatch between package.json and package-lock breaks `npm ci` in CI.
3. Commit, push, and wait for CI green. Do not release from a red build.
4. Stage the npm release: `npx npm@latest stage publish`. Record the staged
   version and shasum. Staging uses the configured NPM_TOKEN credential and
   never needs 2FA.
5. STOP. Ask Joey to approve the staged package at npmjs.com (Staged Packages
   tab, passkey). This is the human gate; nothing ships without it.
6. After approval, tag the exact commit that was packed in step 4, not HEAD,
   which may have moved: `git tag -a v<version> <sha> -m "v<version>: summary"`
   then `git push origin v<version>`.
7. Create the GitHub release from that tag with the changelog section as notes
   and the install command `npx -y @jkudish/discern-mcp`.
8. Verify: `npm view @jkudish/discern-mcp version --prefer-online` returns the
   new version and the release page renders.

## 1.0.0 (the rename) only

- `@jkudish/discern-mcp` is a brand-new package, so 1.0.0 must be published
  interactively by Joey (see the first rule below). It depends on
  `@jkudish/discern-agent-tools` 1.0.0, which must be live first.
- Before step 2, refresh the lockfile against the published
  `@jkudish/discern-agent-tools`; until then it still points at
  jev-agent-tools and `npm ci` fails.
- `@jkudish/jev-mcp` 1.0.0 is an existing package, so it stages normally,
  after `@jkudish/discern-mcp` 1.0.0 is live.
- Rename the GitHub repository from jkudish/jev-mcp to jkudish/discern-mcp at
  release. Docs already link to the new URL; GitHub redirects the old one.
- `npm deprecate` of older `@jkudish/jev-mcp` versions is Joey's call, never
  an agent's.

## Rules and traps

- Staged publishing cannot create a brand-new package. The first version of
  any new package must be published interactively by Joey with
  `npx npm@latest publish` (browser passkey). Everything after that stages.
- Registry propagation lags roughly 5 to 10 minutes after approval. A 404 from
  `npm view` or `npx` right after publish is propagation, not breakage.
- npx caches failed resolutions. After a propagation window, remove
  `~/.npm/_npx` before concluding the package is broken.
- Tag, tarball, and registry version must agree to the byte. Docs that land
  after staging ship in the next release; retagging a published version is
  never correct.
- The npm package README comes from the tarball at stage time, not from
  GitHub HEAD.
- Never republish a version that already exists on the registry.
- The root `files` list must never include `compat/`; `test/compat.test.mjs`
  checks this.

## Verification checklist

- CI green on the release commit.
- `npx npm@latest stage list` showed the staged version and shasum.
- Joey approved; `npm view @jkudish/discern-mcp version --prefer-online`
  returns it.
- The tag points at the packed sha and the GitHub release exists on that tag.
- Repository: https://github.com/jkudish/discern-mcp
