# 0002: Use OIDC for humans and Realmroot extensions for Agents

Status: accepted

## Context

Humans use the browser while Agents call the Resource Server through Realmroot
Toolbox. Browser authentication can use standard OIDC, while Agent execution
needs Realmroot's controller/Agent chain and Session provenance. AK also needs
one normalized tenant identity.

## Decision

Browser sign-in uses OIDC authorization code flow with PKCE, Discovery, JWKS,
nonce validation, and provider logout, then creates an opaque HttpOnly AK
session. Realmroot is the configured provider; these mechanisms are standard
OIDC rather than Realmroot product semantics.

Resource requests use OAuth access tokens and standard DPoP. The current
Resource-token profile fixes the client to Realmroot Toolbox. Realmroot's
controller/Agent actor chain identifies Agent callers, while its optional
organization claim selects organization tenancy. Task Claim additionally
requires Realmroot's signed runtime Session binding. Agent execution preserves
the controller and stable Agent actor separately.

AK scopes every business query by a normalized `owner_id`: the Realmroot
organization identifier when supplied, otherwise an OIDC subject-derived
personal tenant. Unsafe browser requests require CSRF protection. Downstream
Agency access uses server-held or exchanged grants and never exposes tokens to
the browser.

## Consequences

The browser identity-authentication protocol is portable to a compatible OIDC
provider. Complete browser-backed product operation additionally requires OAuth
Resource Indicators, refresh tokens, and token exchange for downstream Agency
access, plus an explicit organization-tenancy and account-management mapping.
Agent/Toolbox access is not provider-neutral because it depends on Realmroot
extensions. AK has no independent Agent-role or tenant-selection authority;
grants remain separate from Task policy.
