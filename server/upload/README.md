# Upload API

The small HTTP service between the capture clients and storage. It signs video uploads, verifies them and registers
each recording in SpacetimeDB; issues the six-digit account passwords; and, on Cloudflare, accepts the GPU worker's
finished scene files. Video bytes never pass through the database: storage holds the bytes, SpacetimeDB the rows.

The full contract (requests, responses, errors, limits) is in [docs/upload-api.md](../../docs/upload-api.md).

## Layout

```
src/
├── handler.mjs        makeHandler(): every /api route, independent of the runtime
├── tickets.mjs        signed, expiring upload tickets (the service keeps no upload state)
├── database.mjs       SpacetimeDB over HTTP: accounts, profiles, create_memory
├── accounts.mjs       portable `memos1.` account keys and request credentials
├── passwords.mjs      the encrypted six-digit password vault (+ its R2 store)
├── connections.mjs    GET /api/connections, a report of the configured interfaces
├── node/              Node runtime
│   ├── server.mjs     the entry point (UPLOAD_STORAGE=s3|local)
│   ├── s3.mjs         S3/R2 storage
│   ├── local.mjs      local-disk storage for development and capture tests
│   ├── local-scenes.mjs, passwords-s3.mjs, passwords-sqlite.mjs
└── cloudflare/        Cloudflare Workers runtime (the hosted site)
    ├── index.mjs      Worker entry point
    ├── worker.mjs     R2 storage, /media/ byte ranges, routing to the modules below
    ├── pipeline.mjs   /api/pipeline/*: the GPU worker's multipart scene publishing
    └── scene-import.mjs  /api/scenes/*: scenes imported from the web library
deploy/
├── docker/            Dockerfile, compose.yaml with Caddy for HTTPS, .env.example
├── cloudflare/        wrangler.jsonc for a standalone Worker
└── sites/             the hosted site's Worker template
tests/
```

## Run it

From the repository root:

| Command                                                         | Storage                         | Notes                                                                      |
| --------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `npm run upload:local`                                          | Local disk (`data/uploads`)     | Development default. Mints a GPU-worker identity on first start.           |
| `npm run upload:dev`                                            | S3/R2                           | Reads `server/upload/.env` (copy `.env.example`).                          |
| `npm run upload:start`                                          | `UPLOAD_STORAGE` (default `s3`) | The deployment entry point; listens on 0.0.0.0 when `NODE_ENV=production`. |
| `docker compose -f server/upload/deploy/docker/compose.yaml up` | S3/R2                           | With HTTPS through Caddy; see `deploy/docker/.env.example`.                |

The Node service listens on port 8788 by default, and the web app's dev server proxies `/api` to it.
