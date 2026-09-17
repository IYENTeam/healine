# Healine

Healine is a self-hosted platform for collecting, storing, and exploring wearable health data. It provides a developer portal, a unified REST API, background synchronization, and an MCP server.

This repository is a fork of [Open Wearables](https://github.com/the-momentum/open-wearables), originally developed by Momentum. The upstream history and [MIT license](LICENSE) are preserved.

## Run locally

Install Docker with Compose, then run:

```bash
git clone https://github.com/IYENTeam/healine.git
cd healine
cp backend/config/.env.example backend/config/.env
cp frontend/.env.example frontend/.env
```

Set `SECRET_KEY`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` in `backend/config/.env` before starting. The administrator is created only while the developer table is empty. Provider credentials can be configured after signing in.

```bash
docker compose up -d --build
```

| Service | Address |
| --- | --- |
| Developer portal | http://localhost:3000 |
| API documentation | http://localhost:8000/docs |
| Task monitor | http://localhost:5555 |

Compose builds Healine from this checkout. PostgreSQL and Redis use persistent volumes. See the [Docker guide](docs/deployment/docker.mdx) or the [development guide](contributing/developing.md).

## Project structure

| Directory | Purpose |
| --- | --- |
| `backend/` | FastAPI, PostgreSQL models, provider integrations, Celery jobs |
| `frontend/` | React developer portal |
| `mcp/` | MCP server for querying stored health data |
| `docs/` | Setup, API, provider, and SDK documentation |

## Polar integration

The inherited Polar connector uses AccessLink v3. AccessLink v4 collection and the Healine Calendar integration are planned extensions; they are not implemented in this fork yet. See the [Polar setup guide](docs/providers/polar-api-integration.mdx) for the current connector.

## Compatibility

The product, local packages, database defaults, and container names use Healine. Existing API routes, the `X-Open-Wearables-API-Key` header, `OPEN_WEARABLES_API_*` environment variables, and upstream mobile SDK identifiers remain compatible. The separately distributed Open Wearables mobile apps and SDKs are upstream products.

The Docker image publishing workflow is opt-in. Configure `HEALINE_PUBLISH_IMAGES=true`, `DOCKERHUB_NAMESPACE`, and the Docker Hub credentials in repository settings before using it. No published Healine image is required for local development.

## Development

Frontend development requires Node.js 22+ and pnpm 10+. Keep the Compose backend services running and stop its frontend before starting the local development server:

```bash
# From the repository root
docker compose stop frontend
cd frontend
pnpm install --frozen-lockfile
pnpm run dev
```

Backend and MCP setup instructions are in [backend/README.md](backend/README.md) and [mcp/README.md](mcp/README.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and contribution guidelines.

Report Healine issues in [this repository](https://github.com/IYENTeam/healine/issues). Upstream reference documentation is available at [openwearables.io/docs](https://openwearables.io/docs).
