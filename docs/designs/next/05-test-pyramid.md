# v2 test pyramid and Agent development rule

Status: implemented

This document defines where behavior is tested and how the Agent verifies its
own changes during development.

Test selection is a per-edit judgment made by the Agent from the observable
behavior at risk. Before running tests, state that behavior, choose the
smallest exact cases that prove it, and run only those cases. Run a full test
file only when every case in it is relevant.

## Placement rule

Test a behavior at the lowest layer that can prove it through a stable public
boundary. Add a higher-layer case only when that layer owns additional risk.
Do not repeat every lower-layer permutation in HTTP, Toolbox, or browser tests.

Each test file belongs to exactly one layer selected by the behavior it proves. New v2 tests
must live in the layer directories below. Existing root-level tests remain in a
temporary `legacy` project until the feature they cover is migrated; `legacy`
is not an acceptable destination for new tests.

```text
tests/
  unit/
    domain/
    application/
    component/
  integration/
    adapters/
    http/
    migrations/
  contract/
    http/
  acceptance/
    toolbox/
  e2e/
```

## Layers and owned cases

| Layer | It proves | Cases that belong here | It must not prove |
| --- | --- | --- | --- |
| Domain unit | Pure business rules and deterministic transformations | Allowed/forbidden state transitions, assignment and separation-of-duty matrices, dependency/cursor predicates, boundary values | Port orchestration, SQL, HTTP, auth middleware, rendered UI |
| Application unit | One use case coordinating explicit ports | Happy path call order, idempotent retry, race result, conflict classification, no-write-on-rejection | D1 schema correctness, Remote token claims, Hono headers, browser behavior |
| Component unit | One React feature/component contract | Loading/empty/error/data rendering, local interaction, accessibility name/role, query-to-view mapping | Full navigation, OAuth, Worker routing, exhaustive browser layout |
| Adapter integration | A real infrastructure adapter | D1 queries and constraints, transaction atomicity, schema application, Remote/Agency request translation, pagination and upstream error mapping | Re-testing all domain policy permutations or HTTP middleware |
| HTTP integration | The assembled Worker operation through Hono and real infrastructure adapters | Authentication normalization, scope and tenant denial, API version, validation, RFC 9457 errors, request ID, ETag/idempotency, routing and response mapping | Exhaustive domain matrices or schema-only assertions |
| HTTP contract | Agreement between the published Resource Server schema and runtime wire behavior | OpenAPI operation/schema/security/header declarations, Toolbox extensions, and representative runtime status/content-type/header agreement | Repository implementation, real D1 behavior, or every auth/domain branch |
| Toolbox acceptance | Realmroot discovery and generated command execution | OpenAPI discovery, resource-first command name, argument mapping, DPoP read/write, wrong audience/scope/tenant rejection, cursor continuation | Generic Toolbox CRUD behavior owned by Realmroot or UI behavior |
| Browser E2E | A critical retained human product journey | Sign-in, board observation, reject/complete, bound Session work display, user-visible empty/error states | Business-rule matrices, SQL constraints, API error permutations |

## Required case families

For each changed behavior, select only applicable families and place each at
the lowest owning layer:

- successful behavior and stable output;
- invalid input or business rejection;
- credential, scope, actor, and cross-tenant denial at the HTTP/Toolbox edge;
- external dependency failure and unknown outcome at application/adapter
  boundaries;
- retry, idempotency, race, and partial-effect recovery where a write crosses a
  boundary;
- schema constraints and forward application; migration, reconciliation, and
  repair cases belong here only when a separate data-upgrade change introduces
  that behavior;
- loading, empty, error, and primary interaction states for changed UI;
- one critical end-to-end journey when multiple deployed boundaries must work
  together.

Not every change needs every family. The test owner records why an applicable
family is absent when the production boundary cannot yet support it.

## Agent development decision rule

For each implementation edit, the Agent decides from the changed behavior:

1. State the observable behavior being changed.
2. Identify which behavior-owning layer can prove that risk completely.
3. Put each case at the lowest layer that completely proves it.
4. Run the exact new or affected cases. Run an entire test file only when all
   of its cases cover the changed behavior.
5. When a real boundary changes, add only the representative boundary cases;
   do not repeat the complete lower-layer decision matrix.
6. After a failure, rerun the failed case plus cases whose behavior the fix may
   have changed.
7. Do not run unrelated cases or default to a whole file, package, layer, or
   repository suite during ordinary iteration.

Test execution must remain deterministic: no fixed sleeps, retry-to-green, or
shared mutable fixtures. This is a property of the selected test, not a reason
to run additional unrelated tests.
