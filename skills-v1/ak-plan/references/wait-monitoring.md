# AK Wait Monitoring Policy

This policy applies to every leader workflow that waits for task or board
progress. `ak-task` and `ak-plan` must use the same wait behavior.

## Command Semantics

`ak wait` is a blocking command. Use it when the next workflow step depends on a
task or board state transition.

After starting `ak wait`, wait for the command to exit. Do not repeatedly poll
the running wait process just to check progress, and do not run separate task,
board, or status commands for the same condition while the wait is still
running.

Some leader runtimes run shell commands as background tool sessions. In those
runtimes, a running `ak wait` session may appear idle for a long time. That is
expected. The leader should wait for command completion, not check every few
seconds whether the command is still running.

Report only meaningful workflow events: task claimed, PR opened, CI failed or
passed, review started, rejection, merge, cancellation, timeout, command
failure, or confirmed blocker.

## Runtime Completion Checks

If the runtime notifies the leader when a background command exits, start
`ak wait` once and resume only when that completion notification arrives.

If the runtime requires explicit session reads to discover whether a background
command exited, use low-frequency checks only to detect completion:

- First check after 3 minutes.
- If still running, check after 5 minutes.
- If still running, check every 10 minutes.

These checks are not status polling. If the wait is still running and nothing
changed, stay quiet and keep waiting.

## Exit Handling

Handle wait exits by result:

- Exit `0`: the condition was met. Continue to the next workflow step.
- Exit `2`: the task was cancelled. Stop that task path and report the
  cancellation.
- Exit `124`: the requested timeout elapsed. Investigate the current state
  before waiting again.
- Network, fetch, tunnel, heartbeat, or operation-aborted error: treat it as an
  interrupted wait. Retry the same `ak wait` command first.
- Any other command failure: surface the exact failure and investigate the
  failing layer before retrying.

## Retry Before Polling

When `ak wait` exits abnormally before the requested workflow condition is met,
retry the same wait command before switching strategy. Use a small bounded retry
loop with backoff:

1. Retry after 30 seconds.
2. Retry after 2 minutes.
3. Retry after 5 minutes.

If those retries fail for the same infrastructure reason, investigate with the
smallest useful command set for the workflow:

- current task or board state
- PR URL when one exists
- recent task notes
- daemon logs
- runtime process health and active child processes when relevant

If investigation shows the worker is healthy and still making progress, stop
using `ak wait` for that condition temporarily and switch to backoff polling with
ordinary read commands:

- First follow-up after 5 minutes.
- Later healthy in-progress checks every 10-15 minutes.
- Use 30-60 second checks only when there is evidence of a near-term transition,
  such as CI actively finishing or a PR just being submitted.

If investigation shows the worker is stuck, follow the skill's stuck-task
recovery path. Do not repeatedly re-wait or poll without learning new
information.

## PR Monitor After Merge

After a leader merges a linked PR, PR Monitor normally completes the task. The
leader should give it a bounded chance to synchronize:

```bash
ak wait task <task-id> --until done --timeout 10m
```

If GitHub confirms the linked PR is merged and the task is still not done after
that bounded wait, a leader identity is allowed to run `ak task complete` as an
ops fallback. Include the PR URL and file an agent-kanban issue with the task ID,
PR URL, `ak` version, and daemon log evidence.
