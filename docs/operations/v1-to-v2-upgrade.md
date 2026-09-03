# V1 to v2 upgrade boundary

The semantic data migration is a separate deliverable. Current local and remote
migration commands enforce one safety precondition before applying the v2
structural schema: every existing Task must be `done` or `cancelled`.

`todo`, `in_progress`, and `in_review` Tasks block the upgrade and their ids are
reported. The command does not infer a new status, assignment, reviewer, or
Agent mapping.

Legacy Agent, Machine, Session, Maintainer, mailbox, GPG, and runtime rows stay
unchanged and v2 does not read them. Physical cleanup, external Agency resource
retirement, export, backup, and rollback require a future migration procedure.

See [ADR 0011](../adr/0011-defer-v1-semantic-migration.md).
