# Changelog

## [0.2.1](https://github.com/araruoss/araru-server/compare/v0.2.0...v0.2.1) (2026-08-30)


### Bug Fixes

* **security:** enforce library access scope ([21f0674](https://github.com/araruoss/araru-server/commit/21f0674ab88eef7d61d9544e22c1e6163c15791b))
* **security:** enforce library authorization scope ([54f8c6c](https://github.com/araruoss/araru-server/commit/54f8c6c100def7f9a2b72b0464556567161c3370))

## [0.2.0](https://github.com/araruoss/araru-server/compare/v0.1.0...v0.2.0) (2026-08-30)


### Features

* **server:** expand administrative platform capabilities ([ebe4a65](https://github.com/araruoss/araru-server/commit/ebe4a657557daa1ec05cb2ba6b7bb37f8d53e577))

## Changelog

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
