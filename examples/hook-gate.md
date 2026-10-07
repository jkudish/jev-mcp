# Gate harness tool calls with Discern hooks

Agent harnesses intercept their own tool calls: a `PreToolUse` hook sees every
proposed action before it runs and can allow, deny, or escalate it. This
source-checkout example connects that interception point to `discern_decide`, so a
written policy, not a hand-written regex list, decides which calls are too
dangerous to run silently. The judgment happens out of band: it adds nothing to
the conversation, and every tool call that does not match the harness matcher
never pays for it.

The same runner serves Claude Code and Codex, which share the hook wire
protocol (a `PreToolUse` JSON payload on stdin, a
`hookSpecificOutput.permissionDecision` verdict on stdout). OpenCode and pi
intercept in-process; their wrappers below shell out to the same script.

## How the gate routes

Speed comes from routing, quality from the judgment; each layer only handles
what the previous one could not:

1. **The harness matcher is the free router.** Scope the hook to the tools
   worth judging (`Bash`, `Write`, `Edit`, MCP tools). Everything else never
   starts a process.
2. **Local rules defer before any model call.** `--skip` regexes match
   obviously safe shapes (`^Bash git status`), and inputs over 4,000 characters
   defer: both print nothing and exit 0, so the harness's own permission flow
   applies at zero cost.
3. **One `discern_decide` call**: candidates `proceed`/`block`, escape hatches on,
   your policy in `priorities`, the tool call framed as untrusted facts;
   it judges exactly what matched.
4. **A verdict is emitted only on a confident, valid judgment.** `deny` needs
   `block` selected with probability at or above `--block-threshold`
   (default 0.85). Everything else prints nothing and exits 0: provider
   errors, timeouts, `invalid_response`, and escapes to `investigate`/`none`
   all defer to the harness's own permission system. A provider outage never
   blocks the agent, and the gate never fabricates an allow.

This is the same shape as the LLM routing literature: the matcher is the cheap
router, the model's Choice distribution is the quality estimator, and the deny
threshold is the cost dial. Raise it to deny less, lower it toward 0.5 to deny
more; like any threshold, tune it against your own traffic, not a benchmark.

## Quick start

Run from a source checkout with Node.js 22 or newer. The OpenCode and pi
adapters also require `node` on the host's PATH; they do not launch the
host application's own executable as a JavaScript runtime.

```sh
npm ci
# Inspect the constructed judgment without any credentials:
node examples/hook-gate.mjs --policy "No force pushes. Never touch the production database." \
  --dry-run < examples/hook-gate-sample.json

# Live (needs TYPESAFE_API_KEY, or a configured DISCERN_PROVIDER):
node examples/hook-gate.mjs --policy-file policy.md < examples/hook-gate-sample.json
```

`--policy` / `--policy-file` carry the policy (bounded at 2,000 characters to
fit `discern_decide` priorities). `--ask` maps the `ask_user` escape hatch to
`permissionDecision: "ask"` (Claude Code only; Codex reports `ask` as an
unsupported verdict and continues the call). There is no auto-allow option:
`proceed` always defers to the harness. `--block-threshold` is between 0.5
and 1. `--timeout-ms` (default 15,000; maximum 60,000) bounds policy loading,
stdin, connection, judgment and cleanup, with up to three additional seconds
for subprocess termination. On timeout the gate defers. Raw stdin is capped
at 32 KiB and complete evidence (including tool name and cwd) at 6,000
characters; oversized inputs defer without judging a truncated action.

The deny reason is shown to the model as feedback, so it names the measured
probability, the threshold, and the first line of the policy, and asks for a
compliant alternative. The MCP client forwards the provider settings it needs
(provider, credentials, optional `DISCERN_MCP_MODEL`), plus the SDK's standard
safe environment. Legacy `JEV_*` names are read through the 1.x alias and
forwarded under their `DISCERN_*` names. It does not forward arbitrary hook environment variables.

## Claude Code

`.claude/settings.json` in the project (or `~/.claude/settings.json`):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/discern-mcp/examples/hook-gate.mjs --policy-file /path/to/policy.md",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Keep the harness `timeout` above `--timeout-ms` so the gate defers first and
the harness never kills a hook that was about to defer anyway. `deny` reasons
reach the model; optional `ask` reasons are shown to the user. Leave at least
three seconds of cleanup margin beyond `--timeout-ms`.

## Codex

`~/.codex/hooks.json` (or inline `[hooks]` tables in `config.toml`):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/discern-mcp/examples/hook-gate.mjs --policy-file /path/to/policy.md",
            "timeout": 30,
            "statusMessage": "Checking tool call with Discern"
          }
        ]
      }
    ]
  }
}
```

Codex requires reviewing and trusting each hook in `/hooks` before it runs,
re-trusting on every change; do not enable `--ask` here, as Codex reports
`ask` verdicts as hook errors and continues the call. A no-verdict exit 0 is
Codex's documented non-decision path and falls back to its approval flow.

## OpenCode

OpenCode plugins intercept in-process. Create
`.opencode/plugins/discern-gate.ts` that shells out to the same runner and throws
to block:

```ts
import { runHookGate } from "/path/to/discern-mcp/examples/hook-gate-adapter.mjs"

export const DiscernGate = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const reason = await runHookGate(
        { hook_event_name: "PreToolUse", tool_name: input.tool, tool_input: output.args },
        ["/path/to/discern-mcp/examples/hook-gate.mjs", "--policy-file", "/path/to/policy.md"],
      )
      // Intentional denial stays outside the adapter's failure recovery.
      if (reason) throw new Error(reason)
    },
  }
}
```

Note that OpenCode's `tool.execute.before` has historically not fired for MCP
tool calls, only built-in tools; check the current behavior on your version.

## pi

pi extensions return `{ block, reason }` from the `tool_call` event. Create
`~/.pi/agent/extensions/discern-gate.ts` for global use, or
`.pi/extensions/discern-gate.ts` in the project, with the same spawn pattern:

```ts
import { runHookGate } from "/path/to/discern-mcp/examples/hook-gate-adapter.mjs"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const reason = await runHookGate(
      { hook_event_name: "PreToolUse", tool_name: event.toolName, tool_input: event.input },
      ["/path/to/discern-mcp/examples/hook-gate.mjs", "--policy-file", "/path/to/policy.md"],
    )
    if (reason) return { block: true, reason }
  })
}
```

## Honesty and calibration

A policy gate is not a security boundary: it is one judgment layer in front of
the harness's own permission system, and a determined process can sometimes
talk past a judge. The tool call text is untrusted input framed as facts, but
framing is mitigation, not a guarantee. Deferring is not approval or assurance
of safety. The shared adapter bounds stdout and runtime, handles pipe/spawn
and JSON errors, and ignores nonzero exits: failures return no decision.

Before trusting a threshold, run a small reproducible experiment: capture real
hook payloads (the `--dry-run` output shape), label each with your own
allow/block/unsure call, then sweep `--block-threshold` and count false denies
(calls blocked that should have run) and misses (calls that ran but should
have been blocked). Repeat with a pinned `DISCERN_MCP_MODEL` before making claims;
a tiny sample is only a smoke test. Expect roughly a second per judged call
(process spawn plus one provider round trip), which is why the matcher and `--skip`
layers exist: judge the few, not the many.

Offline adapter checks run as part of `npm test`. They use controlled
responses and establish integration behavior, not model accuracy; no quality
or latency benchmark is claimed by the fixtures.
