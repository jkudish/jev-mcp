// Discern 1.x environment aliases, applied once when this module is first
// imported, before any other module reads configuration.
//
// Every legacy JEV_<X> variable aliases DISCERN_<X> (normalizeDiscernEnv in
// @jkudish/discern-agent-tools owns the rule): a JEV_<X> set alone is copied
// to DISCERN_<X> and reported in `legacyEnvNames`; DISCERN_<X> wins when both
// match; two different values throw an error that names both variables and
// never their values. After this runs, the rest of the package reads only
// DISCERN_* names. JEV_* names stop working in 2.0.
//
// server.ts and provider.ts import this module first, so embedders of
// `@jkudish/discern-mcp/server` get the same aliases. The CLI imports it
// dynamically so a conflict exits with one stderr line instead of a stack.
import { normalizeDiscernEnv } from "@jkudish/discern-agent-tools";

const { env, legacy } = normalizeDiscernEnv(process.env);
for (const [name, value] of Object.entries(env)) {
  if (value !== undefined && process.env[name] !== value) process.env[name] = value;
}

/** Legacy JEV_* variable names that were set at startup, sorted. Names only, never values. */
export const legacyEnvNames: readonly string[] = legacy;

/** The DISCERN_* name a legacy JEV_* variable maps to. */
export function discernName(legacyName: string): string {
  return `DISCERN_${legacyName.slice("JEV_".length)}`;
}
