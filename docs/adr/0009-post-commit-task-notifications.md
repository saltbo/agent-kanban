# 0009: Notify assigned Agents after Task lifecycle commits

Status: accepted

## Context

Assignment and later lifecycle decisions must wake or inform an assigned Agent
through Inbox. D1 and Inbox do not share a transaction, so a distributed write
can partially succeed.

## Decision

AK commits the authoritative Task mutation first, then sends an Inbox message
for assignment, review rejection, completion, and cancellation. Each message
uses the stable key `ak:<event>:<taskId>:<taskVersion>`. If delivery fails, AK
returns a retryable service failure. Retrying the same idempotent lifecycle
request retries the notification without applying the Task mutation twice.

## Consequences

Task state is never rolled back because Inbox is unavailable. A caller may see
an error after the Task changed and must retry the same request. Inbox must
deduplicate the stable message key; AK logs the boundary failure without
placing credentials or message bodies in logs.
