# Security policy

## Reporting a vulnerability

Email **joey@jkudish.com** with "jev-mcp security" in the subject. Include:

- the package version and how you installed it;
- a minimal reproduction (tool, arguments, environment);
- the impact you observed or expect.

Please do not open public issues for vulnerabilities. There is no bug bounty and no committed response time; reports are handled as maintainer time allows.

## Scope

jev-mcp makes API calls to whichever Jev provider is configured: TypeSafe by default, or OpenRouter, Cloudflare, Vercel AI Gateway, or a Jev-compatible endpoint you point it at. It does not execute browser actions, read files, or make other network calls. Treat any text you send as leaving your environment: it goes to the configured provider, and to nowhere else.

Only the latest released version receives fixes. There is no support policy for older versions yet.
