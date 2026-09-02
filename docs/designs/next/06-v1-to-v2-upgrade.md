# v1-to-v2 upgrade

Status: semantic migration deferred; terminal-task safety gate implemented

The application contains no upgrade-time compatibility readers, actor rewrites,
verification ledgers, cleanup schedulers, or Agency resource retirement. The
supported local and remote migration commands enforce the terminal-task
precondition before applying the v2 structural schema. The structural rebuild
retains legacy values without classifying them as Realmroot actors.

## Required precondition

Before enabling v2 on an existing v1 database, every Task must be terminal:

- allowed: `done`, `cancelled`;
- blocking: `todo`, `in_progress`, `in_review`.

The upgrade stops and reports the blocking Task IDs when this precondition is
not met. It does not guess a new status, assignment, reviewer, or Agent mapping.

## Retained data

Legacy Agent, Machine, Session, Maintainer, mailbox, GPG, and runtime rows stay
unchanged. v2 does not read them. Physical cleanup, external Agency resource
retirement, backup/rollback mechanics, and any eventual archival/export policy
belong to the future upgrade change and are not prerequisites for the v2
application code.
