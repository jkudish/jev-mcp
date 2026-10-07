# @jkudish/jev-mcp

`@jkudish/jev-mcp` was renamed to [`@jkudish/discern-mcp`](https://github.com/jkudish/discern-mcp) at 1.0.0.

This package keeps existing setups working during 1.x. Its `jev-mcp` bin runs `discern-mcp` with `DISCERN_TOOL_NAMES=jev`, so `tools/list` shows the `jev_*` names your config and permission allowlists already use. The `discern_*` names stay callable. `JEV_*` environment variables keep working and print a deprecation line on stderr. `import "@jkudish/jev-mcp/server"` re-exports `@jkudish/discern-mcp/server`.

To migrate, replace `@jkudish/jev-mcp` with `@jkudish/discern-mcp`, rename `JEV_*` variables to `DISCERN_*`, and update allowlists from `jev_*` to `discern_*`. See the [migration guide](https://github.com/jkudish/discern-mcp#migrating-from-jev-mcp).

This package, the `jev_*` tool names, and the `JEV_*` variables are removed in 2.0.
