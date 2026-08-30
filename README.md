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

### Catalog and reader contracts

Library files are identified by a content hash when the provider exposes one (or by a streamed SHA-256 for local files). The catalog pipeline records discovery, metadata, cover and reader-manifest state in PostgreSQL; failures are explicit and retryable. The versioned reader contract is `GET /api/v1/works/:id/manifest`, while content and page resources remain streamed through the existing `/api/v1/works/:id/content` and `/pages` endpoints. Full-text search is provided by `GET /api/v1/search?q=...` and covers works, filenames, tags, authors and series.

Files larger than `READER_MAX_IN_MEMORY_MB` are not read into a Node buffer for metadata extraction. Large local PDFs use `pdfinfo`/`pdftotext` with bounded output; formats without a safe streaming extractor are reported as a retryable pipeline error instead of exhausting memory.

See [Araru Documentation](https://github.com/araruoss/araru-docs), [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), and the AGPL-3.0-only [LICENSE](LICENSE).
