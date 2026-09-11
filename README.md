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

The application is deployed at <https://media.embyfin.uk> behind owner-only Cloudflare Access. The Worker, secrets, custom domain, Cron trigger and Container image are deployed; the initial remote D1 migration is applied. As of 2026-09-11 UTC, owner sign-in is confirmed and Categories/Gimgyrl scans have completed with **31 videos**; the other six libraries await their first scan. Media processing remains **off** pending runtime/device/budget acceptance. The first scheduled backup passed checksum verification and an isolated D1 restore drill, but predates these scans.

Use the [Cloudflare deployment runbook](docs/CLOUDFLARE-RUNBOOK.md) for the exact browser configuration, resource IDs, credentials, repeat deployment commands, verification and troubleshooting. Use [recovery](docs/RECOVERY.md) for data restoration and [release acceptance](docs/ACCEPTANCE.md) for completed and outstanding checks. The implementation is still uncommitted at this checkpoint; preserve the source and keep recovery credentials independently before relying on a fresh-machine rebuild.

[Terraform infrastructure](infra/terraform/README.md) manages D1, private poster/backup buckets and Access applications/policies, with imports for the existing installation and deletion protection. It generates Wrangler configuration from the infrastructure outputs; Wrangler deploys the Worker and Container. Local validation/tests pass; live Terraform adoption needs a separate infrastructure operator token.

The confirmed source bucket is `windows-video-archive`. The read-only inventory on 2026-09-10 UTC found 3,704 objects, 395,908,442,551 bytes, and 1,262 MP4 candidates across eight top-level prefixes; largest candidate: 3,963,895,118 bytes. Secrets remain in ignored `.dev.vars`; private object-key inventories and check reports remain in ignored `.wrangler/` files. Container/codec/browser suitability is not inferred from the extension.

Read-only source requests have no delete/rename/copy path. Exact keys are preserved in D1; keys containing standalone `.` or `..` URL segments remain discoverable but fail with `unsupported_key_path` because URL normalization would otherwise resolve a different key. Changing provider/source configuration after catalog creation fails closed and requires migration.

## Application layout

- `src/worker.js`, `auth.js`, `catalog.js`: private API, Access JWT validation, common grant predicate, literal Unicode search, byte-range streams, account-bound progress.
- `src/scans.js`, `jobs.js`, `index.ts`: transactional checkpoints, replacement invalidation, leased media jobs, singleton Container lifecycle and Cron.
- `public/`: native browser UI, Library/Folders/details/settings, player controls, periodic progress, account-switch cleanup. No client data cache, service worker, movie metadata service, or UI framework.
- `processor/main.py`: one subprocess at a time; loopback-only metered source proxy; pinned object/revision access; real FFprobe/FFmpeg posters. Source reads are reserved before signing and actual usage is logged. Malformed manifests cannot enable playlist/network demuxers; protocol/format allowlists and fixed subprocess arguments restrict decoding.
- `src/backup.js`, `ops/`: R2-maintained export state/manifests, streaming checksum, 30-day retention, independent verification and conservative restore SQL.

## Release verification

[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) separates executed checks from outstanding account/device/resource acceptance. Local checks do not establish Cloudflare Container cold-start cost, metered shutdown, real-account Access switching, mobile seeking, backup export blocking, or a restored production authorization policy.

Sources used to verify platform interfaces: [Container lifecycle API](https://developers.cloudflare.com/containers/reference/container-class/), [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/), [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
