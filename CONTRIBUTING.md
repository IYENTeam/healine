# Contributing to Healine

Use [Healine issues](https://github.com/IYENTeam/healine/issues) for bugs and proposals, and open pull requests against this repository. Describe the behavior being changed, the reason, and the validation performed.

Keep changes focused. Preserve upstream attribution and API compatibility, and update the relevant documentation when behavior changes. Never include credentials or personal health data in commits, issues, or screenshots.

## Checks

Run checks for the components you change:

```bash
# Frontend, from frontend/
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run build

# Backend, from backend/
uv sync --group code-quality
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest

# MCP, from mcp/
uv sync --group code-quality --group dev
uv run ruff check .
uv run ruff format --check .
uv run ty check
uv run pytest
```

Backend integration tests require PostgreSQL and Redis, either through Docker or explicit test service URLs. See [testing](contributing/testing.md).

## Upstream

Healine is derived from [Open Wearables](https://github.com/the-momentum/open-wearables). Keep an `upstream` remote for updates:

```bash
git remote add upstream https://github.com/the-momentum/open-wearables.git
git fetch upstream
```

If the remote already exists, run only `git fetch upstream`. Review and validate upstream changes before merging them. Changes intended for the original project should follow its own contribution guidelines.
