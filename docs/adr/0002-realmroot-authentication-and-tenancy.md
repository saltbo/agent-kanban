# 0002: Use Realmroot identity as the tenancy boundary

Status: accepted

## Context

Humans use the browser while Agents call the Resource Server through Realmroot
Toolbox. AK needs one tenant identity and must preserve the distinction between
the controlling user and the Agent that performs an operation.

## Decision

Realmroot is the only authentication authority. Browser sign-in uses OIDC
authorization code flow with PKCE and creates an opaque, HttpOnly AK session.
Resource requests use Realmroot access tokens; Agent execution preserves the
controller and stable Agent actor separately.

AK scopes every business query by the canonical Realmroot tenant identifier in
`owner_id`. Resource tokens require the configured proof-of-possession binding.
Unsafe browser requests require CSRF protection. Downstream Agency access uses
server-held or exchanged grants and never exposes tokens to the browser.

## Consequences

AK has no independent user, Agent-role, or tenant-selection authority. A grant
provides coarse capability; AK still enforces tenant ownership, task relation,
and lifecycle policy. Authentication, authorization, and tenant denial remain
distinct observable failures.
