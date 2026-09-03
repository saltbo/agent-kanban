# 0003: Publish a resource-oriented API through Realmroot Toolbox

Status: accepted

## Context

Agents need a stable automation surface, but maintaining an AK-specific CLI or
RPC-shaped endpoints would duplicate Realmroot Toolbox and couple clients to
commands instead of product resources.

## Decision

AK is a Realmroot Resource Server and publishes one OpenAPI document. Ordinary
resources use Toolbox's generic verb-first operations. AK supplies
resource-first command names only for Task lifecycle resources: claim, release,
review, reject, complete, cancel, and bounded wait.

HTTP paths contain resource nouns. Known singleton lifecycle resources use
`PUT` or `DELETE`. `API-Version` is optional and defaults to the current v2
contract. Expected v2 failures use RFC 9457 Problem Details and every response
has a server-generated `Request-Id`. Toolbox generates creation idempotency keys
for resources whose contract requires them and reuses a key across automatic
retries.

## Consequences

AK ships no CLI and does not create resource-first CRUD aliases. OpenAPI is the
contract for schema, authorization scopes, discovery, and generated commands.
New operations must first pass the resource and URI design gates.
