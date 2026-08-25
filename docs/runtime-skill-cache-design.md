# Runtime skill cache and dispatch preparation

## Requirements

- While a daemon prepares an assigned task, when a skill or subagent dependency is unavailable, the system shall fail before creating a git worktree.
- While a cached skill snapshot exists, when its upstream source is unavailable, the system shall keep using the last-known-good snapshot.
- While an agent session is running, when the cache refreshes, the session shall continue using the immutable snapshot selected at dispatch time.
- While a user is signed in, when runtime settings are saved, the system shall validate and persist them for that owner and deliver them to the owner's machines through heartbeat responses.
- While automatic refresh is enabled, the daemon shall refresh stale cached skills in the background at the configured interval without delaying daemon readiness.

## Architecture

```text
Settings UI -> user-authenticated runtime settings API -> owner_settings
                                                        |
machine heartbeat <-------------------------------------+
       |
daemon runtime-settings state -> background cache refresher
       |
dispatch preflight -> agent/subagent API + skill cache snapshot
       |
server session -> worktree -> local session record -> snapshot copy -> spawn
                         failure => local/server/worktree cleanup
```

### Frontend

- Add a Runtime settings page using the existing Settings layout and design tokens.
- Expose automatic skill updates and a bounded refresh interval in hours.
- Keep saved/loading/error/dirty-state behavior consistent with Scheduling settings.

### Backend

- Store a normalized JSON runtime-settings document in `owner_settings`.
- Add user-only GET/PUT endpoints and piggyback normalized settings on machine heartbeat responses.
- Use shared validation in the route and fail-safe normalization in the daemon.

### CLI/runtime

- Store cache objects under the machine data directory, keyed by content hash.
- Update a manifest atomically; never mutate an object after publication.
- Copy the selected object into each workspace, so a running agent cannot mutate the cache or observe later refreshes.
- Fetch agent/subagent metadata and resolve every skill snapshot before worktree creation.
- Persist the local session immediately after workspace creation and clean every acquired resource on failure.
- Keep the previous cache object and manifest entry when refresh fails.

## Security checkpoint

- Settings endpoints require user identity and are scoped by authenticated `ownerId`.
- The server validates types and bounds; unknown fields are removed by normalization.
- The heartbeat exposes only operational booleans/numbers, never credentials or cache contents.
- Installer arguments use `execFileSync` rather than a shell command.
- Cache files live below the per-user data directory; manifest publication uses atomic rename.
- Workspaces receive copies instead of writable symlinks into the shared cache.

## Failure modes

- First install offline: dispatch is skipped with a short retry backoff and no worktree is created.
- Refresh offline: last-known-good remains active and the next scheduled refresh retries.
- Cache object missing/corrupt: it is treated as a miss and rebuilt before dispatch.
- Materialization or spawn failure: workspace, local session, server session, GPG home, and task assignment are released.
- Daemon restart: persisted sessions are authoritative for existing worktrees; clean untracked worktrees can be reconciled separately without deleting dirty work.

## Operational cost

- One small immutable copy per unique skill content plus one copy per task workspace.
- One upstream check per cached reference per configured interval; disabled automatic updates still allow first-use cache fills.
- Subagent definitions remain server-backed and are fetched before worktree creation so edits take effect on the next dispatch.
