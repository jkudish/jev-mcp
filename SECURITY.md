# Security policy

## Reporting a vulnerability

Email **joey@jkudish.com** with "discern-mcp security" in the subject. Include:

- the package version and how you installed it;
- a minimal reproduction (tool, arguments, environment);
- the impact you observed or expect.

Please do not open public issues for vulnerabilities. There is no bug bounty and no committed response time; reports are handled as maintainer time allows.

## Scope

discern-mcp makes API calls to whichever provider is configured: TypeSafe (Jev) by default, or OpenRouter, Cloudflare Workers AI (Jev or Clef), Vercel AI Gateway, OpenAI's Decisions API, SubQ Decisions, or a System One-compatible endpoint you point it at. It does not execute browser actions, read files, or make other network calls. Treat supplied text and images as leaving your environment for the configured provider under its retention policy. SubQ retains data, including images, indefinitely by default unless organization ZDR is arranged.

Image inputs are explicit PNG/JPEG base64 envelopes, not URLs or paths. Per-image, aggregate decoded-byte and serialized-argument limits apply on stdio, HTTP and embedded tool calls; HTTP also caps ingress at 4 MiB. The stdio/MCP library parses the frame before tool validation, so these limits do not bound every client/library allocation. Signature checks do not fully decode images. Provider errors/results never echo image bytes; clients and hosts remain responsible for their own argument logs and artifacts.

Image text and visual instructions are untrusted evidence. Prompt framing and model confidence cannot guarantee protection from visual injection. Localization validates presence, uniqueness and geometry, always returns `action:review`, and exposes no box for absent/uncertain/invalid bundles. A digest identifies content, not freshness. No localization response authorizes a browser click or another host action.

This policy also covers the `@jkudish/jev-mcp` compatibility package, which runs discern-mcp.

Only the latest released version receives fixes. There is no support policy for older versions yet.
