# Embyfin

Private video catalog for an existing R2 bucket. Implements the P0 application paths in [PRD.md](PRD.md): a Worker/API and responsive browser UI, D1 catalog and personal state, resumable scans, a bounded FFmpeg Container, and export/recovery tooling. No media is uploaded or moved as part of onboarding.

## Run locally

Requires Node 22.13+ (the integration checks use built-in SQLite), npm, Python 3.9+, and FFmpeg/FFprobe on PATH. Production uses Python 3.12 inside Linux/amd64.

```sh
npm ci
npm run db:migrate
npm run dev
```

Open <http://localhost:8787>. Local D1/R2 are isolated under `.wrangler/`. The local-only entrypoint signs in as `owner@localhost` and accepts only loopback hosts; it is **not imported by the production entrypoint**. An empty library is expected until a source is configured and scanned. The local config does not bind the real source bucket. Do not expose local development through a public tunnel.

```sh
npm test                 # SQL/API invariants and a real FFmpeg decode/poster round-trip
npm run check            # TypeScript entrypoint, browser JS syntax, Python syntax
npm run build            # Compile the production Worker without deploying/building a Container
npm run build:processor  # Requires a running Docker daemon; Linux/amd64 image
```

Tests open an ephemeral loopback-only Range proxy. In a restricted environment, permit local sockets for `npm test`. Native SQLite checks exercise the same migrations and queries; `npm run db:migrate` additionally validates D1 compatibility in Wrangler.

## Deployment configuration

Use the [Cloudflare deployment runbook](docs/CLOUDFLARE-RUNBOOK.md) and [Terraform guide](infra/terraform/README.md) for installation. Terraform manages the catalog, derived buckets and Access; Wrangler releases the Worker and Container. Start processing disabled until representative runtime and budget checks pass.

Production inputs and operational history belong in ignored `.private/` files. [Private deployment context](docs/PRIVATE-CONTEXT.md) explains encrypted R2 backup and recovery. Public examples use synthetic values and do not target a live installation. Generate `wrangler.generated.json` before deployment; never deploy the template directly.

Read-only source requests have no delete/rename/copy path. Exact keys are preserved in D1; keys containing standalone `.` or `..` URL segments remain discoverable but fail with `unsupported_key_path` because URL normalization would otherwise resolve a different key. Changing provider/source configuration after catalog creation fails closed and requires migration.

## Application layout

- `src/worker.js`, `auth.js`, `catalog.js`: private API, Access JWT validation, common grant predicate, literal Unicode search, byte-range streams, account-bound progress.
- `src/scans.js`, `jobs.js`, `index.ts`: transactional checkpoints, replacement invalidation, leased media jobs, singleton Container lifecycle and Cron.
- `public/`: native browser UI, Library/Folders/details/settings, player controls, periodic progress, account-switch cleanup. No client data cache, service worker, movie metadata service, or UI framework.
- `processor/main.py`: one subprocess at a time; loopback-only metered source proxy; pinned object/revision access; real FFprobe/FFmpeg posters. Source reads are reserved before signing and actual usage is logged. Malformed manifests cannot enable playlist/network demuxers; protocol/format allowlists and fixed subprocess arguments restrict decoding.
- `src/backup.js`, `ops/`: R2-maintained export state/manifests, streaming checksum, 30-day retention, independent verification and conservative restore SQL.

## Release verification

[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) lists release acceptance checks. Keep installation-specific results in the private record. Local checks do not establish Cloudflare Container cold-start cost, metered shutdown, real-account Access switching, mobile seeking, backup export blocking, or a restored production authorization policy.

Sources used to verify platform interfaces: [Container lifecycle API](https://developers.cloudflare.com/containers/reference/container-class/), [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
