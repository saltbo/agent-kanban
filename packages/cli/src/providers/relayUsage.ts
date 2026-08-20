/**
 * Relay usage collection — quota windows for Claude Code custom endpoints.
 *
 * The probing implementation lives in @agent-kanban/shared
 * (packages/shared/src/relayUsage.ts) so the web server can probe the same
 * relays; this shim injects the daemon's logger and scheduling settings and
 * keeps the `fetchRelayUsage(endpoint, now)` call signature used by claude.ts.
 *
 * Security: the relay token is passed in from the caller and MUST never be
 * logged, embedded in detail strings, or sent anywhere but the relay itself.
 */

import { probeRelayQuota, type RelayEndpoint, type UsageInfo } from "@agent-kanban/shared";
import { createLogger } from "../logger.js";
import { getSchedulingSettings } from "./schedulingState.js";

const logger = createLogger("relayUsage");

export { detectRelay, RELAY_HOSTS, type RelayEndpoint, type RelayKind } from "@agent-kanban/shared";

/**
 * Fetch quota windows for a known relay. Throws UsageFetchError on HTTP
 * failure (the UsageCollector applies retry/backoff); never returns null for
 * a reachable relay — an empty windows list means "no limits in effect".
 */
export async function fetchRelayUsage(endpoint: RelayEndpoint, now: Date = new Date()): Promise<UsageInfo> {
  const probe = await probeRelayQuota(endpoint, {
    now,
    // Read per call — tests swap scheduling settings between probes.
    scheduling: getSchedulingSettings(),
    warn: (message) => logger.warn(message),
  });
  return probe.usage;
}
