# 0001: Use a single-package layered application

Status: accepted

## Context

Agent Kanban deploys one React application and one Cloudflare Worker. The old
workspace, CLI, video application, and runtime daemon created boundaries that
the product no longer owns.

## Decision

Maintain one pnpm package and one TypeScript project. Browser code lives in
`src/`; server code is split into domain, use-case, adapter, authentication,
HTTP-composition, and Worker-entry layers under `server/`; shared wire types
live in `shared/`.

Dependencies point inward: HTTP handlers and adapters call use cases, and use
cases depend on domain rules and explicit ports. Domain and use-case code do
not depend on Hono, React, D1, Cloudflare bindings, or downstream transport
representations.

## Consequences

There is no pnpm workspace, nested package manifest, AK CLI, local daemon, or
video package. External failures are translated at adapter or HTTP boundaries.
Code is split by responsibility rather than an arbitrary file-size limit.
