#!/usr/bin/env node
// @jkudish/jev-mcp 1.x is a thin alias of @jkudish/discern-mcp. It lists the
// jev_* tool names by default, so existing `npx @jkudish/jev-mcp` configs and
// permission allowlists keep matching; the discern_* names stay callable.
// An explicit DISCERN_TOOL_NAMES (or its legacy JEV_TOOL_NAMES alias) wins.
if (!process.env.DISCERN_TOOL_NAMES && !process.env.JEV_TOOL_NAMES) process.env.DISCERN_TOOL_NAMES = "jev";
await import("@jkudish/discern-mcp/cli");
