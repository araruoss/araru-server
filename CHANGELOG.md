# Changelog

## [0.2.3](https://github.com/araruoss/araru-server/compare/v0.2.2...v0.2.3) (2026-08-30)


### Bug Fixes

* **security:** close remaining library scope gaps ([437b7cf](https://github.com/araruoss/araru-server/commit/437b7cfb0eaf0fc277efb87337fa2285d1bb772c))
* **security:** close remaining library scope gaps ([161f8be](https://github.com/araruoss/araru-server/commit/161f8beb5ff271f77222f1cb493767e60067eef4))

## [0.2.2](https://github.com/araruoss/araru-server/compare/v0.2.1...v0.2.2) (2026-08-30)


### Bug Fixes

* **auth:** remove test environment authorization bypass ([d6de450](https://github.com/araruoss/araru-server/commit/d6de4508816b4839a90a60e88d82d2e5913495fe))
* **auth:** remove test environment authorization bypass ([badabae](https://github.com/araruoss/araru-server/commit/badabae621069509ed965894ee00a7a5843681c2))
* **docker:** harden development service exposure ([1affa58](https://github.com/araruoss/araru-server/commit/1affa5820323ec0ec87ca1cac037dd5c35319fb6))
* **docker:** harden development service exposure ([d5dd87f](https://github.com/araruoss/araru-server/commit/d5dd87f2aa481dfe139f026439fc43331342c8ed))

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
