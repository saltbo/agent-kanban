# Contributing

Thanks for your interest in Agent Kanban! Here's how to get involved.

## Getting Started

1. Fork the repo and clone it locally
2. Install dependencies: `pnpm install`
3. Run migrations: `pnpm db:migrate`
4. Start dev server: `pnpm dev`
5. Run the exact tests selected for your changed behaviour

## Making Changes

- Create a feature branch from `main`
- Keep changes focused — one concern per PR
- Change or add the scenario in `spec/*.feature` first
- Add `[spec: capability/scenario]` to the cheapest proving test
- Run `pnpm lint:spec` and the exact changed test cases before submitting

## Code Style

- TypeScript throughout
- Thin repo layer for data access — no raw SQL in route handlers
- Centralized error handling via `HTTPException`
- Short functions (< 30 lines), small files (< 300 lines)
- Name things clearly — if it needs a comment to explain *what*, rename it

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(api): add task dependency cycle detection
fix(cli): handle missing config file on first run
refactor(web): extract activity log into standalone component
```

## Database Migrations

If your change modifies the D1 schema:

1. Create a new SQL file in `migrations/`
2. Name it `NNNN_description.sql` (sequential number)
3. Include both the schema change and any data backfill
4. Test with `pnpm db:migrate`

## Reporting Issues

Open an issue with:
- What you expected vs. what happened
- Steps to reproduce
- Environment (OS, Node version, browser)

## License

By contributing, you agree that your contributions will be licensed under the [FSL-1.1-ALv2](LICENSE) license.
