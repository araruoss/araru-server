# Changelog

All notable changes to Araru Server are documented here. Releases follow [Semantic Versioning](https://semver.org/) and are generated from Conventional Commits.

## Unreleased

### Separação do Araru Server

- backend transformado em projeto Node independente;
- migrations, testes, scripts operacionais e contrato OpenAPI incluídos;
- Docker, CI e releases GHCR próprios;
- PostgreSQL e Redis validados sem dependência do antigo monorepo.

Esta entrada não altera automaticamente a versão do software.
## Unreleased

- Expanded `/api/v1/works` filtering with library, author, category, format, reading and ordering filters.
- Added v1 administration endpoints for metadata, jobs, backup and security summaries.
- Added liveness/readiness health endpoints and API benchmark scenarios (`npm run benchmark:api`).
- Extended OpenAPI coverage for v1 filters, administration and health contracts.
- Removed unversioned product endpoints. `/api/v1` is now the sole official product API; health probes remain technical routes outside the product namespace.
