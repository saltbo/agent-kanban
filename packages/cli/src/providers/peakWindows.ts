/**
 * Peak-window evaluation for relay quota scheduling.
 *
 * Implementation lives in @agent-kanban/shared (packages/shared/src/peakWindows.ts)
 * so the web server can evaluate the same windows; re-exported here to keep
 * existing CLI import sites unchanged.
 */

export { isPeakNow, minutesNow, nextOffPeakStart } from "@agent-kanban/shared";
