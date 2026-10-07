// Discern 1.x environment aliases. Each listed legacy JEV_<X> variable is read
// as DISCERN_<X> (normalizeDiscernEnv in @jkudish/discern-agent-tools owns the
// rule): a JEV_<X> set alone is used and reported; DISCERN_<X> wins when both
// match; two different values are an error that names both variables and never
// their values. JEV_* names stop working in 2.0.
//
// The library never changes process.env: createServer() and the tools read a
// normalized copy through discernEnv(). Only the bin entry (index.ts) calls
// applyLegacyEnv(), once, before it starts a transport, the same split as
// discern-browser.
import { DISCERN_ENV_NAMES, normalizeDiscernEnv, type Env } from "@jkudish/discern-agent-tools";

/** Every variable this server reads, as suffixes after DISCERN_ (or JEV_). */
export const MCP_ENV_NAMES: readonly string[] = Object.freeze([
  ...DISCERN_ENV_NAMES,
  "MCP_MODEL",
  "MCP_REQUEST_TIMEOUT_MS",
  "MCP_MAX_ATTEMPTS",
  "MCP_TRANSPORT",
  "MCP_AUTH_TOKEN",
  "MCP_PATH_TOKEN",
  "MCP_MAX_CONCURRENCY",
  "TOOL_NAMES",
]);

/** A normalized copy of the environment. Throws on a JEV_/DISCERN_ conflict; never changes process.env. */
export function discernEnv(env: Env = process.env): Env {
  return normalizeDiscernEnv(env, MCP_ENV_NAMES).env;
}

/** For the bin entry only: writes the DISCERN_ copies into process.env and returns the legacy names used. */
export function applyLegacyEnv(): readonly string[] {
  const { env, legacy } = normalizeDiscernEnv(process.env, MCP_ENV_NAMES);
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && process.env[name] !== value) process.env[name] = value;
  }
  return legacy;
}

/** The DISCERN_* name a legacy JEV_* variable maps to. */
export function discernName(legacyName: string): string {
  return `DISCERN_${legacyName.slice("JEV_".length)}`;
}
