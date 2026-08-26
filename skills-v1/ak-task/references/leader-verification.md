# Leader Verification Policy

This policy is shared by leader workflows such as `ak-plan` and `ak-task`.
Follow it whenever reviewing a task PR.

## Three Gates

All PRs must pass three gates before merge:

1. Code review
2. Functional acceptance
3. Agent notes review

Reject as soon as a required gate fails. Do not ask the user to decide during
human-not-in-the-loop execution.

## Functional Acceptance

Passing tests, CI, and code review is not completion. Validate the feature from
the product/user perspective before accepting it.

Required checks:

- Re-read the target repo's contribution or project instructions before testing.
- Walk through every item in the task's `## Checks` section.
- Visit the preview/staging deployment and verify end-to-end when applicable.
- Check for regressions in related features.
- Run project-specific verification steps.
- Treat worker-reported tests, CI, screenshots, notes, and claims as supporting
  evidence only. They never replace leader-owned functional acceptance.

## Non-Production Verification Blockers

Preview, staging, local dev, and other non-production environments are
agent-operable verification environments.

If functional acceptance is blocked in a non-production environment, recover the
environment and continue verification. Examples include missing credentials,
stale migrations, missing feature/license data, bad seed data, authorization
setup, corrupted test state, local env gaps, or broken browser fixtures.

Allowed recovery actions include resetting test passwords, applying migrations,
creating test users, seeding test data, enabling test-only feature/license
bindings, recreating broken non-production state, and rerunning deployment or CI
checks.

Production is the exception: do not mutate production credentials, customer
data, license state, or other production resources unless the user explicitly
authorizes that specific action.

## Verification Attempt Budget

Try at least **5 distinct verification strategies** before waiving verification.
Distinct means materially different paths, not five retries of the same failing
command.

Examples:

- preview URL
- local dev server
- direct API call
- CLI command
- database inspection
- logs
- seeded test account
- alternate browser/session
- project-specific smoke script
- targeted test command

For each attempt, capture evidence: command, URL, environment, timestamp if
useful, exact error/output summary, screenshot/log reference if available, and
what it proves.

## Acceptance Status

Record acceptance status explicitly as one of:

- `passed`
- `failed`
- `blocked`
- `waived`

Meanings:

- `passed`: leader-owned functional acceptance succeeded.
- `failed`: the feature was testable and did not satisfy the task.
- `blocked`: fewer than 5 distinct strategies were attempted, or a known fix
  path remains. `blocked` cannot merge.
- `waived`: at least 5 distinct strategies were attempted, all failed for
  environment/tooling reasons, and the verification comment records which
  feature's functional verification was skipped and why the skip is real.

## Verification Infrastructure Learning

A verification waiver is evidence of missing project infrastructure. Treat it as
a root-cause signal, not a one-off inconvenience.

When Gate 2 is `waived`:

1. Create a new task that fixes the verification blocker before merging or
   moving to the next feature review.
2. The task must target the reusable harness/infrastructure problem, not the
   feature that happened to expose it.
3. The task description must include:
   - Which feature's verification was waived.
   - The 5+ verification attempts and evidence.
   - The root verification gap, such as missing preview auth, seed data, smoke
     script, browser fixture, local env setup, migration path, test account, or
     documented runbook.
   - The durable acceptance checks that future agents must be able to run.
4. Add the infrastructure task as a dependency of every later incomplete task
   that would hit the same verification blocker.
5. Ensure labels used by the infrastructure task already exist on the board;
   create reusable missing labels first.

Example:

```bash
ak create task \
  --board <board-id> \
  --repo <repo-id> \
  --assign-to <agent-id> \
  --title "Fix verification harness for <area>" \
  --description "<root-cause verification infrastructure spec>" \
  --labels "infra,test"

ak update task <later-task-id> --depends-on <existing-deps>,<infra-task-id>
```

If the current reviewed PR is otherwise correct and Gate 2 is validly waived, it
may still merge with the waiver evidence. Future related tasks must not continue
until the verification infrastructure task is done.

## Verification Comment

Post a verification comment on the PR before merging:

```bash
gh pr comment <pr-number> --repo <owner>/<repo> --body "$(cat <<'EOF'
## Verification

### Functional Test
- Acceptance status: passed | waived
- Feature verified or waived: <specific feature/check>
- Visited: <staging/preview URL tested, or N/A with reason>
- Golden path: <what was tested and result, or skipped with reason>
- Edge cases: <what was tested and result, or skipped with reason>

### Verification Waiver
<Only for waived. List at least 5 distinct verification attempts with evidence:
1. <strategy> — <command/URL/evidence> — <why it could not verify>
2. ...
Reason verification was skipped: <concise reason>

### Test Suite
<test commands run and pass/fail summary>

### Conclusion
All gates pass, or functional verification is waived with required evidence — merging.
EOF
)"
```

Before merge:

- If `Acceptance status` is `passed`, the visited target and golden-path result
  are required for user-facing work.
- If `Acceptance status` is `waived`, the comment must identify the skipped
  feature and include at least 5 distinct verification attempts with evidence.
- Otherwise, do not merge.
