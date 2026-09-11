# Implementation and release acceptance

Status: **deployed for acceptance**. Owner sign-in and the first two library scans are complete; bulk media processing remains disabled. P1/Later/Out stories remain out of scope as specified in the PRD. Reproduction instructions and the browser configuration are in the [Cloudflare runbook](CLOUDFLARE-RUNBOOK.md).

Terraform infrastructure is now defined in [infra/terraform](../infra/terraform/README.md), including existing-resource imports and generated Wrangler configuration. Terraform 1.10.2 with Cloudflare provider 5.24.0 passed formatting/schema validation and two mock plan tests. Live adoption completed on 2026-09-11 using the approved `embyfin-terraform` token: seven imports, two disabled R2 development URL settings, zero existing resources changed or destroyed. The follow-up live plan reported no changes; all nine managed instances are recorded, and generated Wrangler configuration exactly matches production. Remote state has been migrated into the dedicated private `embyfin-terraform-state` R2 bucket with native locking; resources/outputs were preserved and the remote plan is clean. A client-encrypted recovery archive is verified in private R2; the owner confirmed saving its private age key in 1Password; the temporary local key file has been removed. See [recovery instructions](RECOVERY.md#encrypted-workstation-recovery-archive).

## Scan checkpoint — 2026-09-11 UTC

A read-only production D1 check after the operator started scanning confirmed:

| Library | Prefix | Scan | Catalog videos | Ignored objects | Boundary |
|---|---|---|---:|---:|---|
| Categories | `Categories/` | Complete; no error | 13 | 26 | Frozen |
| Gimgyrl | `Gimgyrl/` | Complete; no error | 18 | 36 | Frozen |
| Movies, Random, Stars, Studios, TV, Unsorted | Corresponding top-level prefix plus `/` | First scan not started | 0 | — | Editable |

There are **31 videos**, one enabled owner identity, and 31 pending enrichment jobs. Neither completed library is paused. Processing is still disabled, so queued jobs and missing thumbnails are expected. No other scans were started during the documentation check. The first verified backup below predates library setup and these scans; a new post-scan backup still needs independent verification.

## Live deployment — 2026-09-11

- URL: `https://media.embyfin.uk`; Worker version `852a16d7-571a-4593-b38e-201da5d0aeb6`. All four secret bindings are present; values were not printed or committed. Workers Paid is active.
- Container application `a038b6cc-adf5-4dd5-b333-9c18ed676b55`; Durable Object namespace `97b105e93beb485b82546fcedab46173`; image digest `sha256:9ace8efb4ea98850cfb48ee926cd3f92436e2cb2cd5eda39425869ba0ddf3333`. The image built and uploaded after explicitly setting its repository-root build context in Wrangler.
- HTTPS is active. Anonymous requests to `/`, `/app.js`, `/api/session`, and `/api/admin` redirect to Access. Unsigned/expired processor requests return `401`; a correctly signed nonexistent run returns `409 stale_run`. `embyfin.x-downloader.workers.dev` returns `404`.
- One-minute Cron invocations succeeded in live logs. The first automatic backup completed in 117 seconds including the configured drain; its 6,191-byte SQL export passed independent SHA-256 verification. Key: `daily/2026-09-11/1789109329.sql`; SHA-256: `eb002e5d76b16b37bf5001fc833efafd0dd2ab44ceb987488fa967cc74ccca96`.
- The backup restored into isolated D1 `embyfin-restore-check-20260911` (`61d7e5c1-bf9b-4cbf-a70d-1d25bd13bd4a`), which is not bound to the serving Worker. Its schema and then-empty catalog counts matched. Synthetic records were then added only to that database: 3 users, 2 libraries, 2 videos, 2 grants and stale leases. Recovery cleared all five access/lease checks while retaining one favorite and a 12-second resume position; libraries were paused. Recovery plus verification took 2.78 seconds, excluding creation/import. This does not establish recovery duration for a populated production catalog or a live cutover.
- The drill exposed D1's compound-SELECT limit in `ops/verify-restore.sql`. The query now uses `json_each(json_object(...))`; the existing integration check and real D1 verification both pass.
- Initial provisioning created 8 unscanned libraries: Categories, Gimgyrl, Movies, Random, Stars, Studios, TV and Unsorted. The later scan checkpoint above supersedes that initial empty-catalog state. Originals and unrelated resources were untouched.
- The `media` Container instance is inactive; no thumbnail workload has run in Cloudflare. The account already has an enabled, automatically created budget email alert. It was left unchanged. The available native notification types did not include a Worker backup-age or missing-Cron alert; independent backup monitoring and its delivery destination still need configuration.

Still required: two real account isolation/switching checks; first scans for any of the remaining six libraries the operator wants included; representative Cloudflare processing and device playback/seeking; agreed spending ceiling and explicit processing enablement; independent backup alert delivery and missing-schedule detection; a verified post-scan backup and populated-catalog restore/cutover acceptance. Target devices and budget remain unspecified. The isolated restore database is retained as test evidence. Source/docs are pushed to the private GitHub recovery branch. The encrypted source/credential/state archive in R2 has been verified; the owner confirmed 1Password key storage and the temporary local key file was removed.

## Earlier checks

Executed locally: 18 Node integration checks and two Python checks passed, including actual FFmpeg decoding. The 10,000-item local SQL search/scope check took approximately 14–16 ms in this environment; this is not a Worker p95 measurement. The production Worker dry-run build and syntax checks passed. Wrangler applied all 24 statements in the initial D1 migration. Browser checks covered owner library creation, Library rails, literal `%_` search, details, persisted favorite changes, virtual folders, and a 390-pixel viewport. Docker was initially unavailable, then started successfully; Linux/amd64 build and local image execution passed as recorded below. Cloudflare workload lifecycle acceptance remains pending.

| Area | Implemented checks | Deployment acceptance still required |
|---|---|---|
| Connection and inventory | Read-only CLI bucket inventory; actual R2 S3 listing/HEAD and matching revision fingerprints; exact-key catalog; short non-final pages; duplicate-key upserts; invalid cursor restart; permission failure without missing reconciliation; pause persistence; D1 migration; live Cron; Categories/Gimgyrl scans complete | Credential scope confirmation, remaining library scans as desired, deliberately observed browser-closed continuation, source replacement/removal on a dedicated test prefix |
| Sharing | Common predicate across queries, counts, folders, details, posters, media; disabled users/libraries; CSRF and account-bound writes; signed Access issuer/audience tests | Real Access admission-only/grant-only cases, logout/provider account chooser, two disjoint signed-in accounts |
| Library and personal state | Both views; Unicode literal search; filters and sorting; four home rails; details; replacement clears progress/recent activity and preserves favorites; stale generation/sequence rejection | Cross-device resume and realistic 10,000-item performance measurement |
| Playback | Streamed single Range contract including suffix/open/malformed ranges, validators, replacement detection; actual R2 S3 206 reads at start/middle/end, processor presigned GET, 412 stale ETag and 416 out-of-bounds responses; native controls and bounded failure diagnostics | Start/middle/end seeks and audio on agreed desktop/mobile browsers; expired Access/revoked access during playback |
| Processing | Real local H.264/AAC fixture → FFprobe → decoded JPEG; Linux/amd64 image build and local execution; uploaded image and Paid account; run/job leases; bounded proxy reads; subprocess/scratch/time limits; versioned per-lease posters; stale callbacks and attempts | Cloudflare cold start, representative mixed/corrupt/portrait/large files, enforced idle/hard stop, metered usage and cost ceiling |
| Recovery | R2 gate before D1; real consistent export/polling and SHA-256 verification; measured initial backup duration; isolated D1 import and synthetic state recovery; streamed manifests, 30-day retention, independent checker | Post-scan backup; populated-catalog restore/cutover with owner UI unavailable; current authorization reconciliation; alert delivery; measured production RPO/RTO |

During the initial inventory on 2026-09-10 UTC, the configured CLI account could inspect `windows-video-archive`: 3,704 objects, 395,908,442,551 bytes, Standard storage; 1,262 MP4 candidates across eight top-level folders. A bounded management-API sample read succeeded but returned HTTP 200 despite a Range request. That endpoint is used only for inspection; application playback uses signed S3 requests. That inventory step did not modify originals, start catalog scans or provision resources; provisioning followed later.

The installation uses one library per top-level folder. Categories and Gimgyrl now have frozen boundaries; the other six remain editable before their first scans. The 600 GB PRD estimate differs from the initial inventory; neither object count nor `.mp4` implies device compatibility.

During the credential check on 2026-09-11 UTC, the operator-supplied credentials passed read-only validation: 100 S3 objects listed; a 123,879,893-byte MP4 returned matching list/HEAD revision fingerprints; four 1 KiB reads (start, middle, end, and processor presigned URL) returned HTTP 206; stale ETag and out-of-bounds requests returned 412 and 416. That check read only 4 KiB of media. The account-owned D1 token verified as active and could list databases; its export authority was subsequently proved by the completed backup above. The credential check used only GET/HEAD and changed no cloud data. Credential values remain in ignored `.dev.vars` with mode 0600; the sanitized check report is in ignored `.wrangler/credential-check.json`. Successful reads do not establish that write permissions are absent.

Later on 2026-09-11 UTC, the following resources were created through the authenticated Cloudflare dashboard in account `a58958f1af472b99313d58370ff74638`:

| Resource | Identifier / configuration |
|---|---|
| D1 `embyfin` | `45db29f5-b8cb-40a0-9263-12e0a6319d6a`; verified empty before applying all 24 statements in `0001_initial.sql` remotely with Wrangler |
| R2 `embyfin-posters` | Standard storage; public access disabled |
| R2 `embyfin-backups` | Standard storage; public access disabled |
| Access `Embyfin` | `553b565e-41c6-4350-8fd5-fcb68d6354a6`; `media.embyfin.uk`; 24-hour session; HTTP-only cookie; email one-time PIN |
| Access `Embyfin owner` policy | `c09c9d9a-a9b6-4de0-8142-1c2544729975`; Allow only `maneeshvettukattil@gmail.com` |
| Access `Embyfin processor` | `70cba25e-bad9-4997-b90b-990f33e9d26c`; exact destination `media.embyfin.uk/machine/*`; hidden from App Launcher |
| Access `Embyfin processor callbacks` policy | `a30174a4-46de-4661-8ac1-37dbb8ce5f65`; Bypass / Everyone only on the processor application; handlers validate their own expiring run credential |

The Access issuer is `https://orange-sky-811f.cloudflareaccess.com`; the browser application's audience is recorded in `wrangler.jsonc`. The existing `embyfin.uk` zone had no DNS records before setup; Wrangler subsequently attached the Worker custom domain and uploaded the secrets. Original videos and existing Cloudflare applications were left untouched. The operator clarified that cleanup of Embyfin-owned resources is allowed; unrelated resources and original videos must remain untouched. Exact browser fields, identity-provider selection, cookie settings and recreation steps are in the [deployment runbook](CLOUDFLARE-RUNBOOK.md).

Deployment preparation on 2026-09-11: Docker Desktop started successfully and the Linux/amd64 processor image built. Both Python checks passed inside that image with external networking disabled, including synthetic H.264/AAC decoding and JPEG generation: 781 ms elapsed, 705 ms CPU, 106,790,912 bytes peak RSS, 8,950 bytes scratch, and 154,440 source bytes over two mocked range reads. These measurements use local emulation, not Cloudflare runtime. The initial Free-plan blocker was resolved by the operator's Workers Paid upgrade. Deployment, live Access checks and the initial backup/isolated restore then succeeded; real Cloudflare media processing remains unverified.
## Controlled production sample — 2026-09-11

Two bounded launch attempts were made at 12:27:49 and 12:35:57 UTC, using the existing image digest. The sample allowed only three IDs: `7c16e23f-2740-4cc6-9c82-6106b64b6c1d` (3,874,525 bytes), `242ee8a7-0d18-4dec-a788-902781c5caff` (7,397,743 bytes), and `84e47a68-edf3-4304-ab8f-5870a950864f` (4,096 bytes, suspected invalid media). Limits were 30 seconds and 32 MiB per job, 150 seconds per batch, one container, and a ten-minute sample expiry preventing another automatic dispatch. Only the first stopped, zero-read run's cooldown was reset for the second attempt.

**Result: failed before media processing.** Both runs stopped with `lease_expired`; neither produced a claim or heartbeat. All selected jobs remained pending with zero attempts/read requests/read bytes, no metadata, and no poster key. Jobs outside the sample had zero attempts. The second attempt logged `embyfin_processor_started`, followed by a canceled Durable Object scheduled event; the Container-only dashboard showed no application events. The local image's entrypoint and digest matched the intended processor. These observations do not establish the underlying startup/callback failure. No media throughput, decoding resource usage, corrupt-file handling, or production cost estimate was established.

The Worker now allows up to 30 seconds for startup using the SDK's normal retries, logs startup success/failure, and preserves an existing stop reason during reconciliation. Local checks passed: TypeScript/syntax, 19 Node integration tests (including sample isolation/expiry), and both Python checks including real FFmpeg decoding. The Python loopback test needed execution outside the filesystem sandbox.

Cleanup verified: Worker version `549f194c-a8b4-485d-bda4-fec76168c833` restored `PROCESSING_ENABLED=false`, empty `PROCESSING_SAMPLE`, and ordinary job/batch limits. D1 reported the run stopped and Wrangler reported the sole instance inactive. Original objects were unchanged. Full-queue processing remains disabled; startup/callback diagnosis and a successful sample are still pending. The repeat procedure is in [CLOUDFLARE-RUNBOOK.md](CLOUDFLARE-RUNBOOK.md#controlled-poster-test).

### Follow-up: startup fixed and sample passed — 13:00 UTC

This supersedes the startup blocker above. Diagnostics showed an immediate process exit (code 1), then a private, temporary stderr-capture wrapper established `batch_started` followed by `batch_stopped: network`. An unauthenticated POST comparison reproduced HTTP 403 with `Python-urllib/3.12` and the expected application HTTP 401 with `Embyfin-Processor/0.1`. The processor now identifies itself on every machine callback. Access policies, request authentication and WAF settings were not changed. The temporary wrapper/private diagnostic endpoint was removed before the successful test. Startup, exit and sanitized HTTP failure logs remain.

The corrected sample started at **12:57:57 UTC**, produced two posters, rejected the invalid file, and exited with code **0 at 12:58:36 UTC**. Every selected job had one attempt; no outside job was attempted.

| Video ID prefix | Result | Elapsed | CPU | Peak RSS | Reserved source bytes / requests | JPEG bytes |
|---|---|---:|---:|---:|---:|---:|
| `7c16e23f` | Ready; 69.823 s, 640×360 | 10.726 s | 323 ms | 68,878,336 B | 19,194,558 / 7 | 18,092 |
| `242ee8a7` | Ready; 134.383 s, 555×416 | 14.707 s | 534 ms | 68,304,896 B | 21,168,790 / 7 | 17,749 |
| `84e47a68` | `unsupported_or_corrupt` | Not recorded | Not recorded | Not recorded | 4,096 / 1 | None |

Both R2 poster objects were independently read and checked for JPEG signatures and bounded size. Source reservations totaled **40,367,444 bytes**; overlapping FFprobe/FFmpeg range requests count again. Each job stayed below 32 MiB and 30 seconds. Reservations are conservative counters, not a billing measurement. Two small valid files do not establish performance or cost for the full collection, large/portrait/mixed-format files, or forced hard-stop behavior. The temporary wrapper did exercise the 60-second idle shutdown. No original objects were modified or deleted.

Final Worker **`28be55b0-5c2e-4134-8ba5-2c6e61b69e94`** retains the fix with `PROCESSING_ENABLED=false`, empty `PROCESSING_SAMPLE`, and ordinary limits restored. Container image: `registry.cloudflare.com/a58958f1af472b99313d58370ff74638/embyfin-processor@sha256:b9f6c523f5ab6ae975b19b125dcde182f6a4e31f59b0fd7fcbed1b546b476099`. D1 run is stopped and the sole instance inactive. The controller currently labels reconciled stopped runs `lease_expired` even after a normal process exit; the observed exit code above is authoritative for this test. Validation passed: TypeScript/syntax, 19 Node checks and three Python checks, including the client-identity/authentication regression and real FFmpeg round trip. Full-queue processing remains disabled.
