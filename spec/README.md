# Product specs (BDD-lite)

`spec/*.feature` is the product behaviour source of truth. The files are
executable specifications in structure, but AK does not run them through
Cucumber. Ordinary Vitest and Playwright tests prove each scenario at the
cheapest useful layer.

Each scenario has exactly one stable id and one proof layer:

```gherkin
@tasks/claim @api
Scenario: The assigned Agent claims a Task
```

The proving test includes the same id in its name:

```ts
it("[spec: tasks/claim] claims the assigned Task", async () => {})
```

Proof layers:

| Tag | Home | Purpose |
| --- | --- | --- |
| `@domain` | `server/domain/**/*.test.ts` | Pure state and authority rules |
| `@usecase` | `server/usecases/**/*.test.ts` | Application orchestration with port fakes |
| `@api` | `server/http/**/*.test.ts` or `tests/integration/http/**/*.test.ts` | Assembled HTTP contract and real D1 boundaries |
| `@web` | `src/**/*.test.tsx` | Component behaviour with a mocked API boundary |
| `@e2e` | `tests/**/*.spec.ts` | A small number of real browser journeys |

Scenario ids never change. If product behaviour is replaced, remove the old
scenario and add a new id. `pnpm lint:spec` checks ids, tags, duplicates, and
test breadcrumbs. Keep this directory pure: only this README and `.feature`
files belong here.
