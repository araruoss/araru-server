# Araru Server

Self-hosted digital library server powering the Araru ecosystem. It owns catalog, storage integrations, metadata, covers, reading state, administration and background jobs.

## Requirements

- Node.js 22.5+
- PostgreSQL 16+
- Redis 7+ when cache is enabled
- `p7zip` and `poppler-utils`

## Quick start

```bash
cp .env.example .env
npm ci
npm run migrate
npm start
```

The API listens on `http://localhost:3001`. Configure Araru Web independently through `VITE_API_URL`.

## Commands

- `npm run dev`, `npm start`
- `npm test`, `npm run lint`, `npm run build`
- `npm run migrate`, `npm run health`
- `npm run benchmark:catalog`

PostgreSQL is the source of truth; Redis stores cache and ephemeral coordination. Runtime data belongs in `storage/` and is never committed. Build the container with `docker build -t araru-server .`; releases publish `ghcr.io/araruoss/araru-server`.

See [Araru Documentation](https://github.com/araruoss/araru-docs), [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), and the AGPL-3.0-only [LICENSE](LICENSE).
