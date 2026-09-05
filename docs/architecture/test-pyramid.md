# Test pyramid and development selection

Test a behavior at the lowest layer that proves it through a stable boundary.
Add a higher-layer case only for risk owned by that boundary.

| Layer | Owns |
| --- | --- |
| Domain unit | deterministic rules, transitions, predicates, boundary values |
| Application unit | use-case orchestration, port failures, retries, races |
| Component unit | rendered states, local interaction, accessibility contracts |
| Adapter integration | D1 constraints and external request/response translation |
| HTTP integration | auth, tenant/scope denial, validation, headers, Problem Details |
| HTTP contract | OpenAPI declaration and representative runtime agreement |
| Toolbox acceptance | discovery, generated commands, DPoP, deployed resource access |
| Browser E2E | a small set of critical human journeys |

New unit and component tests live in `tests/unit/`. Real boundaries live in
`tests/integration/`; schema agreement lives in `tests/contract/`; deployed
Toolbox journeys live in `tests/acceptance/`; browser journeys live in
`tests/e2e/`. Root-level tests are legacy and are migrated when their owning
feature changes.

Before running tests during development:

1. name the observable behavior at risk;
2. select the lowest owning layer;
3. start with the named cases or focused files that prove it;
4. after a failure, rerun the failed and directly affected cases;
5. broaden to a file, project, or suite when shared fixtures, configuration,
   cross-cutting changes, or required checks make that scope meaningful.

Full suites are not the default iteration loop. Static checks may have a wider
natural scope, and required CI gates still apply. Reuse passing results until
subsequent changes affect their validity.

For each changed behavior, select the applicable case families rather than
copying a fixed matrix into every layer:

- successful behavior and stable output;
- invalid input and business rejection;
- authentication, scope, actor, and cross-tenant denial at a protected edge;
- external dependency failure and unknown outcome at application or adapter
  boundaries;
- retry, idempotency, races, and partial-effect recovery for writes that cross a
  boundary;
- schema constraints and forward application when storage changes;
- loading, empty, error, and primary interaction states for UI changes;
- one end-to-end journey only when multiple deployed boundaries create risk
  that lower layers cannot prove.

Not every change needs every family. When a relevant boundary cannot yet prove
an applicable family, record the missing coverage and reason instead of hiding
the gap or adding a weaker duplicate test.

Tests are deterministic and do not use fixed sleeps, retry-to-green, or shared
mutable fixtures. See
[ADR 0010](../adr/0010-bdd-specification-and-test-pyramid.md) and
[`spec/README.md`](../../spec/README.md).
