# Product specs (BDD-lite)

`spec/*.feature` is the product behaviour source of truth. The files are
executable specifications in structure, but AK does not run them through
Cucumber. Ordinary Vitest and Playwright tests prove each scenario at the
cheapest useful layer.

Each scenario has exactly one stable journey id, one product entry point, and
one canonical proof layer:

```gherkin
@journey:tasks/claim @entrypoint:toolbox @proof:integration
Scenario: The assigned Agent claims a Task
```

The proving test includes the same id in its name:

```ts
it("[spec: tasks/claim] claims the assigned Task", async () => {})
```

Entry points identify the surface through which behavior is observed. Current
values are `product-ui`, `toolbox`, `public-http`, `http`, `webhook`, and
`deployment`.

Proof layers:

| Tag | Home | Purpose |
| --- | --- | --- |
| `@proof:unit` | `tests/unit/` or owning source unit test | Pure rules, use cases, and component behavior |
| `@proof:integration` | `tests/integration/`, `tests/contract/`, or a retained root integration test | Real adapters, storage, HTTP, schema, and boundary contracts |
| `@proof:e2e` | `tests/e2e/` | A small number of real browser journeys |

Journey ids never change. If product behaviour is replaced, remove the old
scenario and add a new id. `pnpm lint:spec` checks the metadata, duplicate ids,
proof placement, and orphaned test breadcrumbs. A scenario may have additional
tests at other layers, but exactly one layer is its canonical proof. Keep this
directory pure: only this README and `.feature` files belong here.
