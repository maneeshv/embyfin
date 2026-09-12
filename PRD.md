# Embyfin — Product requirements and user stories

**Status:** Product requirements baseline; deployment evidence is maintained privately.
**Date:** 2026-09-10  
**Product:** A private, shared video library built directly on object storage.  
**Initial storage provider:** Cloudflare R2. AWS S3 follows through a narrow storage adapter.

**Architecture revision:** Cloudflare-only default, including Containers for media processing; subject to phase-zero workload and cost acceptance. See [architecture and data-flow diagrams](docs/diagrams/README.md).

## 1. Product outcome

Turn an existing collection of videos in R2 into a searchable, thumbnail-based streaming library. Users can browse their existing folders, find a video by its filename or path, watch compatible originals, and return to their own viewing history. The owner controls who can see each library.

The original objects remain where they are. No re-upload, filesystem mount, media volume, or permanent local mirror is required. A database stores the catalog and application state; generated thumbnails live in a separate object-storage bucket.

This is a video-library product inspired by Emby and Jellyfin, not a movie-identification service or a commitment to reproduce their entire feature sets.

## 2. Confirmed requirements and working assumptions

### Product requirements

| Requirement | Product consequence |
| --- | --- |
| Videos already exist in an R2 bucket. | Discover existing objects in place; uploading is not the onboarding flow. |
| R2 first, AWS S3 later through an adapter. | Keep provider-specific listing and reads behind a small boundary from the start. |
| Multiple users with sharing controls. | Authentication, library permissions, and private per-user viewing state are v1 requirements. |
| Play originals first; clearly flag incompatible videos. | No automatic transcoding or promise that every original plays in every browser. |
| Videos are organized by object folders and filenames. | Preserve exact keys; derive searchable filename and folder fields. |
| Both Library and Folder/File views are needed. | Provide two views of the same catalog and the same video IDs. |
| Library should surface viewing activity. | Continue Watching and Recently Watched are primary home sections. |
| Generate thumbnails from videos. | Media enrichment is part of v1, independent of object listing. |

### Defaults chosen for this PRD

- One deployment, one owner/administrator, multiple viewers. No organizations, billing, public signup, or SaaS tenancy.
- Sharing means the owner grants named users access to a library backed by a bucket prefix. Viewers cannot reshare. Public links and per-video sharing are later work.
- One R2 source bucket initially, with one or more non-overlapping library prefixes. A scope is the bucket root or an exact slash-terminated folder prefix. A whole-bucket library cannot coexist with a nested library in v1; reject ambiguous overlap during configuration. Source and prefix become immutable when the first scan starts; changing them requires a future migration feature, not an ordinary settings edit.
- Responsive web application for desktop and mobile browsers. Native TV apps and casting are deferred.
- Case-insensitive literal filename/path search initially; no transcripts, semantic search, or automatic subject recognition.
- Temporary, bounded memory/scratch during media processing is allowed. Durable media and application data remain in R2 and D1. This is not a claim of zero temporary bytes outside object storage.
- Manual scans plus a daily scheduled reconciliation. A scan can be paused and resumed.
- Cloudflare is the default runtime provider, including containerized media processing. Workers Paid is required; account availability, workload fit, and total costs must be validated before provisioning.
- Object count, codecs, durations, largest object, storage class, update frequency, and target devices must be measured per installation.

These defaults make the requirements implementable without another design round. Section 12 identifies the measurements required before implementation decisions become release promises.

## 3. Users and primary journeys

**Owner:** Connects the source, selects library prefixes, admits users, grants access, starts scans, and resolves processing failures.

**Viewer:** Browses permitted libraries, searches filenames, watches videos, and manages personal progress and favorites. The owner also has these capabilities.

### Journey A — Make the existing bucket useful

1. Owner configures an existing R2 bucket and a library prefix through deployment configuration and the owner settings page.
2. Connection validation checks list/read access and access to the separate generated-assets bucket.
3. Owner starts a scan. Video candidates appear with filename, path, size, and a placeholder as each page commits.
4. Background processing adds duration, dimensions, codec details, and a poster image.
5. The scan page distinguishes inventory completion from enrichment completion. Failed videos remain visible with an explanation.

### Journey B — Find a known file

1. Viewer opens Folders and follows breadcrumbs through the existing object prefixes, or searches part of a filename/path.
2. Results show the original filename and parent folder to disambiguate duplicates.
3. Viewer opens the video details and starts playback.
4. Returning to the list preserves the folder, search, sort, and scroll position where practical.

### Journey C — Resume watching

1. Viewer opens Library and sees Continue Watching, Recently Watched, Recently Added, and Favorites.
2. Selecting a partially watched video offers Resume and Start Over.
3. Progress follows that account between supported devices.
4. Watched state and history are separate for every viewer.

### Journey D — Share a subset

1. Owner admits the viewer in Cloudflare Access, adds the matching application user, and grants access to a named library. These are separate steps with separate status.
2. The viewer signs in and sees only that library in browsing, search, folders, and home sections.
3. Owner revokes the grant. Subsequent metadata, image, and video requests are denied.
4. Already received or buffered bytes cannot be taken back; this is access control, not DRM.

### Journey E — Change accounts on a shared device

1. Viewer selects Sign Out; playback stops and visible private state is cleared before navigating through managed logout.
2. Sign-in identifies the new account before loading its library. A remaining identity-provider session may require the provider's account chooser or sign-out.
3. Late responses and unsent playback updates from the old account cannot populate or modify the new account's state.

## 4. Scope and user-story backlog

**P0:** Required for the first release. **P1:** Useful next increment; not a launch requirement. **Later:** Explicit future capability. **Out:** Outside this product's present purpose.

Acceptance criteria below are requirements to test during implementation, not results already achieved.

### 4.1 Connection, catalog, and enrichment

| ID | Priority | User story | Acceptance criteria |
| --- | --- | --- | --- |
| ING-01 | P0 | As an owner, I want to connect my existing R2 bucket so I can use the videos without moving them. | Validate list/read access; store no credentials in client code; connection does not upload, rename, or delete originals. |
| ING-02 | P0 | As an owner, I want to define a library using an object prefix so I can organize and share a subset of the bucket. | Save bucket root or a slash-terminated folder prefix; reject overlap; preview the sharing boundary before the first scan; freeze source/prefix once scanning starts; names and grants remain editable. A root library prevents nested sharing in v1. |
| ING-03 | P0 | As an owner, I want a complete initial inventory so all existing video candidates become discoverable. | Follow every pagination cursor; record exact key, filename, folder, byte size, source timestamp, and revision evidence; report skipped non-video objects. |
| ING-04 | P0 | As a viewer, I want to browse while scanning continues so I do not wait for every video to be processed. | Committed pages are visible immediately; missing posters use placeholders; scan/enrichment states are distinct. |
| ING-05 | P0 | As an owner, I want scans to resume after interruption so a large collection does not restart from zero. | Cron resumes committed checkpoints without an open browser; replayed pages are idempotent; expired/invalid cursors restart safely without duplicates; abandoned leases expire; pause prevents continuation until explicitly resumed. |
| ING-06 | P0 | As an owner, I want rescans to detect additions, replacements, and missing videos so the catalog stays accurate. | Unchanged objects do not trigger new probes; replacements invalidate derived metadata; failed scans never mark unrelated objects missing. |
| ING-07 | P0 | As a viewer, I want thumbnails generated from the actual videos so I can recognize them visually. | A decoded frame is persisted in the derivative bucket; rotation/aspect ratio are respected; failures show a stable fallback and retryable status. |
| ING-08 | P0 | As a viewer, I want duration and technical details so I can judge a video's length and likely playback compatibility. | Probe duration, dimensions, container, and audio/video codecs when available; unknown values remain unknown rather than zero or invented. |
| ING-09 | P0 | As an owner, I want scan and processing status so I can see what finished and what needs attention. | Counts for discovered, enriched, pending, failed, ignored, and missing items; last successful scan; clear errors without secrets. |
| ING-10 | P0 | As an owner, I want to pause scans and retry failed processing so I can control resource use. | Pause stops new scan steps/job claims; in-flight bounded work may finish; retry targets failed/stale items rather than reprocessing everything. |

### 4.2 Library, folders, and search

| ID | Priority | User story | Acceptance criteria |
| --- | --- | --- | --- |
| LIB-01 | P0 | As a viewer, I want a visual Library page so I can browse videos using thumbnails and filenames. | Paginated cards show filename, poster/fallback, duration if known, and watch state; only authorized items appear. |
| LIB-02 | P0 | As a viewer, I want Continue Watching so I can return to unfinished videos. | Show only my available, authorized videos with saved unfinished progress; offer Resume and Start Over. |
| LIB-03 | P0 | As a viewer, I want Recently Watched so I can revisit videos I watched before. | Order by my last playback activity for the current content revision; never show a same-key replacement as already watched or expose another user's activity. |
| LIB-04 | P0 | As a viewer, I want Recently Added so I can find newly discovered videos. | Use first catalog discovery time and label it clearly; initial-import items have deterministic ordering. |
| LIB-05 | P0 | As a viewer, I want Favorites so I can quickly return to videos I care about. | Favorite/unfavorite persists per account and works consistently in both views. |
| LIB-06 | P0 | As a viewer, I want a Folder/File view so I can navigate the structure I already use in R2. | Show virtual folders, immediate children, breadcrumbs, and original filenames; no duplicate catalog is created. |
| LIB-07 | P0 | As a viewer, I want to search filenames and folder paths so I can find videos whose location or name I remember. | Case-insensitive literal contains matching; punctuation, spaces, Unicode, percent, and underscore are handled as data; searches are permission-scoped. |
| LIB-08 | P0 | As a viewer, I want to search within a folder or across my libraries so I can narrow results. | Visible scope selector; nested-folder search includes descendants; global search never includes unshared libraries. |
| LIB-09 | P0 | As a viewer, I want sort and filter controls so I can browse a large collection efficiently. | Sort by filename, first discovered, source modified time, size, or known duration; filter watched/unwatched, favorites, and library; unknown duration sorts last. |
| LIB-10 | P0 | As a viewer, I want a details page so I can inspect a video before playing it. | Show filename, path relative to the shared library, size, duration, source timestamp, format, and availability; never label upload time as recording time. |
| LIB-11 | P0 | As a mobile viewer, I want usable navigation and controls so I can browse and watch on my phone. | Responsive layouts, readable filenames, touch targets, keyboard focus, labeled controls, and empty/loading/error states. |

### 4.3 Playback and personal state

| ID | Priority | User story | Acceptance criteria |
| --- | --- | --- | --- |
| PLAY-01 | P0 | As a viewer, I want to play a compatible original directly from storage so I can start without downloading the entire file first. | Native browser playback through an authorized byte-range endpoint; no full-file buffering in the app server and no automatic transcoding. |
| PLAY-02 | P0 | As a viewer, I want pause, seek, volume, playback speed, and fullscreen controls so I can watch comfortably. | Native controls plus minimal accessible speed control where needed; seek works near the start, middle, and end; platform limitations are respected. |
| PLAY-03 | P0 | As a viewer, I want playback position saved to my account so I can continue on another supported device. | Save periodically and on pause/end; Resume returns within 15 seconds of the last successfully saved position. |
| PLAY-04 | P0 | As a viewer, I want to mark a video watched or unwatched so my library reflects what I have seen. | Ended playback marks watched; manual changes persist; Start Over resets resume state; unchanged rescans preserve state; replacement clears position, watched, and last-watched activity while preserving the favorite. |
| PLAY-05 | P0 | As a viewer, I want playback failures explained accurately so I know whether to retry, sign in, or use another device. | Distinguish confirmed unsupported-on-this-device, unavailable/changed object, permission loss, expired login, network failure, and unknown failure when evidence permits; a generic browser error never globally marks a file unsupported; show technical facts and retain discoverability. |
| PLAY-06 | P0 | As a viewer, I want to recover from an expired login or interrupted connection so I can continue watching. | Check authentication and availability when media errors are ambiguous; tolerate Access redirects/HTML responses; reauthentication preserves the same account's last saved position; retries are bounded; revocation does not retry forever. |
| PLAY-07 | P0 | As a viewer, I want to watch outside my home network so I can use the library wherever I sign in. | Authorized HTTPS access works without a home server, VPN, or router port-forwarding. |

### 4.4 Accounts, sharing, and operations

| ID | Priority | User story | Acceptance criteria |
| --- | --- | --- | --- |
| ACC-01 | P0 | As an owner, I want to admit named users so only approved people can sign in. | Document Access-policy admission separately from the D1 user and library grant; bootstrap the first owner through deployment configuration; show incomplete setup; test both admission-only and grant-only cases; no public signup or implicit library access. |
| ACC-02 | P0 | As an owner, I want to grant and revoke library access so each viewer sees the right subset. | Owner-only permission changes; grants cover descendants; all read paths enforce the same authorization rule. |
| ACC-03 | P0 | As a viewer, I want private viewing history and favorites so other viewers do not see my activity. | APIs read/write only my user state; owner administration does not include a viewer-history screen. |
| ACC-04 | P0 | As an owner, I want to disable a user so I can end their future access. | Next protected request is denied even with an existing identity session; no guarantee of erasing already delivered bytes. |
| ACC-05 | P0 | As a viewer, I want to sign out and switch accounts so a shared device does not display my private library or activity to the next user. | Stop/unload media, clear account-scoped visible/cached state, discard unsent writes and late responses, invoke managed logout, and verify the new identity before fetching data; never replay old writes under a new account; test another tab and browser-back restoration; previously accepted writes remain attributed to their original account. |
| OPS-01 | P0 | As an owner, I want the originals protected so a scan or processing failure cannot damage my collection. | Source access uses read-only credentials; generated assets go to a separate bucket; no original-delete/rename UI or adapter method. |
| OPS-02 | P0 | As an owner, I want catalog and account-state backup and recovery so a database failure does not erase sharing or viewing history. | Daily consistent exports, 30-day retention, a provisional 24-hour maximum data-loss target, and operator recovery without the application UI; restore into an isolated database and verify counts, state, and current authorization before cutover; surface stale backups outside the D1-backed UI. |
| OPS-03 | P0 | As an owner, I want processing budgets and visible failures so scanning does not produce uncontrolled usage. | Bound active instances, subprocesses, runtime, scratch, retries, and per-job reads; explicitly stop idle/overdue containers; persist budgets and failure reasons; demonstrate no duplicate processing under overlapping ticks or stale callbacks. |
| OPS-04 | P0 | As an owner, I want scheduled refreshes so newly added objects appear without repeated manual scanning. | Cron starts each due daily scan only when none is active, then advances bounded scan work without the browser; retries resume safely; overdue/error status is visible; paused runs remain paused. |

### 4.5 Deferred and excluded user stories

These preserve the relevant Emby/Jellyfin ideas from the earlier feature discussion without making every feature a launch requirement.

| ID | Priority | User story | Scope decision / future acceptance boundary |
| --- | --- | --- | --- |
| FUT-01 | P1 | As a viewer, I want a custom title, description, and tags so I can organize videos beyond their filenames. | Manual metadata only; preserve original key and survive rescans. Current search needs only names and folders. |
| FUT-02 | P1 | As a viewer, I want playlists or collections so I can group related videos. | Explicit ordering; adding an item never grants access to it. |
| FUT-03 | P1 | As a viewer, I want Play Next so I can watch a folder or playlist in sequence. | Use explicit sequence/natural filename order, not inferred TV seasons; opt-in autoplay. |
| FUT-04 | P1 | As a viewer, I want to download an original so I can open it locally or watch offline. | Explicit authorized download; no managed offline sync/native app in this story. Hiding the button is not copy protection. |
| FUT-05 | P1 | As an owner, I want to replace an unhelpful poster so the video is recognizable. | Choose another timestamp and regenerate a versioned image; original remains unchanged. |
| FUT-06 | Later | As an owner, I want to connect AWS S3 so I can use the same library experience with another provider. | Implement the adapter contract, authorization/Range tests, region/signing behavior, and provider-specific transfer-cost controls. |
| FUT-07 | Later | As an owner, I want compatible renditions of selected videos so more devices can play them. | Opt-in remux/transcode, measured cost, progress/cancel, separate objects; never rewrite originals or silently process the entire collection. |
| FUT-08 | Later | As a viewer, I want subtitles and audio-track selection so I can choose available languages. | Surface tracks only when present or supplied; do not assume personal videos have external subtitle metadata. |
| FUT-09 | Later | As a viewer, I want casting or a native TV client so I can watch on a larger screen. | Requires a tested device-specific authentication and streaming flow. Browser fullscreen alone is not casting. |
| FUT-10 | Later | As an owner, I want to share a single video so I can grant narrower access than a library. | Authenticated item grants first; explicit expiry/revocation if public links are ever added. |
| FUT-11 | Later | As a viewer, I want synchronized group playback so I can watch with others remotely. | Everyone must independently have permission; state synchronization and reconnect behavior need their own design. |
| FUT-12 | Later | As a parent, I want content restrictions and access hours so I can limit a child's viewing. | Explicit labels and schedules; personal videos have no trustworthy automatic age ratings. Library grants provide basic separation today. |
| FUT-13 | Later | As a viewer, I want to customize home sections so my library opens the way I prefer. | Start with fixed useful sections; save per-user ordering only when requested. |
| FUT-14 | Later | As a viewer, I want easier TV sign-in so I do not type a password using a remote. | Depends on a supported TV client; ordinary web sign-in is v1. |
| FUT-15 | Later | As a viewer, I want to skip repeated intros or credits so I can get to the content. | Requires actual segment data/detection; not assumed useful for arbitrary personal videos. |
| FUT-16 | Later | As a viewer, I want to find words spoken inside videos so I can search beyond filenames. | Requires opt-in transcription, language support, privacy/cost decisions, and a separate searchable transcript model. |
| OUT-01 | Out | As a movie viewer, I want cast, ratings, synopses, and posters fetched automatically so I can discover commercial titles. | Wrong metadata source for this collection; use actual file/probe metadata and generated posters. |
| OUT-02 | Out | As a TV-series viewer, I want automatic show/season/episode organization so I can binge a series. | Preserve existing folder structure; do not infer television structure from arbitrary filenames. |
| OUT-03 | Out | As a music listener, I want artist/album browsing and music playlists so I can enjoy a music collection. | This product catalogs videos, not a separate music library. |
| OUT-04 | Out | As a family member, I want a standalone photo library so I can browse photos. | Generated posters are supported; general photo management is not. |
| OUT-05 | Out | As a reader, I want books and comics alongside my media so I can read them in the same application. | No relevance to the confirmed video use case. |
| OUT-06 | Out | As a TV viewer, I want live channels and a program guide so I can watch current broadcasts. | Existing object-storage videos only; no live ingest or tuner integration. |
| OUT-07 | Out | As a TV viewer, I want scheduled recordings so I can watch broadcasts later. | No DVR pipeline. |

## 5. Interface and behavior requirements

### Navigation

- **Library:** Continue Watching, Recently Watched, Recently Added, Favorites, and All Videos. Home rails have View All links and bounded queries.
- **Folders:** Library selector, breadcrumbs, immediate subfolders, file rows/cards, and optional recursive search. "Folders" are projections of key prefixes, not mounted directories.
- **Video:** Poster, original filename, permitted relative path, details, Resume/Play, Start Over, watched toggle, and favorite toggle.
- **Settings (owner only):** Libraries, admission/grant setup, scan status, processing failures, schedules, backup status, and the recovery runbook. Disaster recovery is an operator procedure independent of this page.

### Names, paths, and timestamps

- Preserve the exact object key as the storage identity, including Unicode, case, spaces, and punctuation. UI rendering must escape it safely. Never concatenate it into a shell command or treat it as a local path.
- Search normalization must not change stored keys. Two files with the same basename in different folders remain distinct.
- Use source + exact key as uniqueness, not basename, display title, or ETag alone.
- A key with a trailing slash may be a folder-marker object; ignore it as a video. Empty virtual folders need not appear unless a marker exists.
- Show only the path relative to the user's permitted library. Do not reveal sibling prefixes or bucket credentials.
- Distinguish source last-modified/upload time, first catalog discovery, and last watched. None automatically means recording/capture date.

### Search

Search filename and library-relative folder path using parameterized, escaped literal matching. Search scope, sort, count, and pagination must apply the same access predicate. SQL wildcard characters entered by the user are literals, not query operators.

Maintain separate normalized search fields and normalize the query using the same Unicode-aware case-folding rules. Do not rely on SQLite's default ASCII-only case-insensitive matching for non-ASCII names; exact storage keys remain untouched.

Start with SQL matching and ordinary indexes for library, parent path, timestamps, and user state. Benchmark against the actual file count. Add D1 FTS5 only if measured search latency fails the release target; adding it must retain documented filename/path matching behavior. No separate search service or vector database in v1.

### Watch state

- Save at most once per 15 seconds during active playback, plus pause/end where delivery succeeds. Do not write to D1 on every time-update event.
- Continue Watching contains unfinished playback after a saved position greater than zero. Ended playback or manual marking completes a video; do not guess that a short video is complete because it crossed a fixed percentage.
- Use a server-issued playback-session generation and increasing update sequence. A stale tab/session cannot overwrite a newer active session's progress.
- A browser close may lose unsent progress; the recovery guarantee is based on the last successful save.
- On detected replacement at the same key, preserve the catalog ID and favorite, but clear position, watched flag, and last-watched/recent activity for every user; invalidate playback sessions and technical metadata/poster. Progress writes carry the source revision as well as session generation, so old tabs cannot restore old activity. A same-revision rescan preserves all state; a missing object alone retains history. Do not resume into different content.

## 6. Recommended architecture

### Decision

Use **Cloudflare Workers + Access + D1 + private R2**, with **Cloudflare Containers running Python/uv + FFprobe/FFmpeg**, controlled by one **Durable Object** and **Workers Cron Triggers**. Use native HTML video playback. Keep the browser application and API together; do not introduce microservices for catalog, search, users, or playback.

**Cloudflare Containers is the default candidate to validate.** It provides the native runtime the processor needs within the existing provider. Containers is available on Workers Paid and is generally available; this does not establish that our files fit its limits or that our bill will be lower. The earlier Google Cloud Run proposal is superseded. Consider another processor host only if measured constraints justify it, preserving the job API and storage adapter. [Containers overview](https://developers.cloudflare.com/containers/), [GA announcement](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/)

### Components

| Component | Responsibility | Persistent data |
| --- | --- | --- |
| Responsive web UI | Library/folder views, search, playback, owner settings | None authoritative in the browser |
| Cloudflare Worker | Authentication/authorization, catalog queries, scan steps, job API, media streaming | D1 bindings/configuration and secret references |
| Workers Cron Triggers | Resume bounded scan/export work and dispatch due enrichment without a browser | Schedules in deployment configuration |
| Container Durable Object | Start/stop one named instance; enforce run generation, activity renewal, and deadline | Minimal lifecycle state only; no second catalog or job queue |
| D1 | Catalog, paths, library grants, favorites/progress, scan checkpoints, leased jobs | Structured records only |
| Existing R2 bucket | Original video objects | Originals, unchanged |
| Separate private R2 bucket | Generated posters and later optional derivatives | Versioned generated assets |
| Private R2 backup bucket | Consistent SQL exports and backup manifests, inaccessible to viewers/processors | Daily backups; no duplicate originals |
| Cloudflare Container processor | Probe videos, decode poster frames, report results | Ephemeral scratch only; authoritative outputs go through Worker/R2 |
| Managed identity | Authenticate approved email identities | Authentication handled by Cloudflare Access; application roles/grants live in D1 |

Data flow:

1. **Discovery:** Manual intent or Cron → bounded Worker scan step → scoped R2 listing → D1 catalog/checkpoint/jobs. Later Cron ticks resume the checkpoint even after the browser closes.
2. **Enrichment:** Scheduled/manual Worker dispatch → Durable Object starts a bounded container run. The processor claims a job through the Worker → reads that original through a short-lived object-scoped URL → probes/decodes → uploads an allowed artifact → reports completion to the Worker. Authenticated heartbeats update D1 leases and renew controller activity only for the current run.
3. **Browsing:** Browser → authorized Worker API → D1. Browsing/search do not list the bucket or open each original.
4. **Images:** Browser → authorized poster endpoint → private generated-assets bucket.
5. **Playback:** Browser → authorized media endpoint → original object byte ranges. Video bodies are streamed, not materialized in Worker memory.
6. **Personalization:** Browser → authorized progress/favorite endpoint → account-scoped D1 records.
7. **Recovery:** Scheduled Worker → D1 export API → streamed SQL copy and manifest in private R2 backups. An operator can import into isolated D1 and verify before cutover without using the application UI.

### Why D1 rather than a hosted SQLite file

D1 avoids operating a database server or persistent filesystem for the application, and fits a modest shared catalog. The total video size is not the database size: object count and stored metadata determine catalog capacity. Keep binary media and images out of SQL. Develop against local D1 with the same migrations; do not maintain a second production SQLite deployment.

D1 currently allows 500 MB per database on the free plan and 10 GB on paid. It supports FTS5 if future search needs it. These are provider facts; suitability for this collection remains a measurement, not a capacity guarantee. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 SQL support](https://developers.cloudflare.com/d1/sql-api/sql-statements/)

### Why a separate media processor

Object listing does not decode videos. FFprobe can inspect container/stream metadata from a URL; FFmpeg must read and decode video bytes to produce a frame. Ordinary Workers have constrained isolate memory/CPU and are not the chosen environment for arbitrary FFmpeg processing. [FFprobe](https://ffmpeg.org/ffprobe.html), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Cloudflare Media Transformations was considered as a simpler managed thumbnail path. Its documented input limits of 100 MB and 10 minutes, with a preferred H.264 MP4 input, make it an unsuitable universal default for an unmeasured mixed collection. Cloudflare Stream would introduce a managed encode/storage/delivery pipeline; it is not needed for the confirmed direct-original scope. [Media Transformations](https://developers.cloudflare.com/stream/transform-videos/)

The processor reads remote ranges where the container permits seeking. It does not promise a fixed small number of bytes per poster: fragmented, damaged, non-seekable, or unusually indexed files may require much more data. Default processing is remote-read based; full-original temporary downloads require an explicit per-job size budget and must never grow into a library mirror.

### Container lifecycle and scheduling

Start with one named Container instance and one video subprocess at a time. Cron calls a short Worker scheduled handler, which checks D1 for due work and asks the Durable Object controller to start a batch. The container runs a batch entrypoint and calls the machine job API; it does not need a public HTTP server. Never keep the Cron invocation alive until a whole batch or backfill finishes. A provisional one-minute dispatch/scan tick checks a 15-minute enrichment cadence, plus owner-requested runs. The daily inventory schedule is separate from scan continuation. [Cron container example](https://developers.cloudflare.com/containers/examples/cron/)

The following are **initial spike limits**, not measured capacity guarantees. Validate or revise them against the sample before launch:

| Control | Initial value / rule |
| --- | --- |
| Instance | Benchmark `standard-2`: 1 vCPU, 6 GiB RAM, 12 GB ephemeral disk; choose the smallest measured-sufficient type |
| Concurrency | One active instance/run, one video subprocess; cap FFmpeg threads; no automatic fleet scale-out |
| Per-video limits | 120-second subprocess deadline, 256 MiB cumulative source reads, 1 GiB scratch; report budget-exceeded separately from format failure |
| Batch limit | 10-minute total wall time including startup; do not claim a job without sufficient remaining time |
| Lease / heartbeat | 90-second lease, 15-second heartbeat, bounded by the batch's absolute deadline; only the current token/generation can renew |
| Attempts | At most three transient-error attempts with backoff; deterministic corruption/unsupported-by-processor/budget failures need explicit review or a changed budget |
| Idle / hard stop | Explicit 60-second activity timeout; exit when no jobs remain; at deadline allow at most 15 seconds for graceful shutdown, then force termination |

These are application-enforced limits: measure and interrupt actual bytes read, including FFmpeg's requests, rather than only limiting object size. Bounded remote reads are the default; full-video scratch downloads are disabled initially. The platform's disk includes the container image, so leave headroom for the image/runtime and outputs. Current predefined instances extend to 4 vCPU, 12 GiB RAM, and 20 GB disk; ordinary defaults do not imply unlimited scratch. Build a Linux/amd64 image and assume scratch can disappear between runs. [Container limits](https://developers.cloudflare.com/containers/platform/limits/), [Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/), [Container FAQ](https://developers.cloudflare.com/containers/faq/)

The controller's durable state stores the active run generation and deadline; D1 remains authoritative for run/job leases, retries, budgets, and outcomes. Acquire the D1 run lease before starting, persist the controller deadline before launching work, and recover either partial failure on the next tick. After a lost lease or restart, reject old callbacks, confirm the old process is stopped, and reconcile the active slot before replacement. Never infer exactly-once execution from a Cron tick or a container name. Avoid application-created restart loops on `onStop`/OOM; retry only via bounded scheduled dispatch. The provider may restart a process independently, so every batch entrypoint must revalidate its run generation and absolute deadline before any new claim or read.

`sleepAfter` measures activity, not FFmpeg progress: background CPU and outbound reads must not be assumed to reset it. A valid in-budget heartbeat renews controller activity. Use the Container class's durable scheduling facility for an independent deadline, preserving its built-in alarm handling. A graceful `stop()` alone is insufficient for the hard ceiling; use `destroy()` after the bounded grace period and verify the instance is stopped. No keep-alive may extend the absolute deadline. If the control plane is delayed, a wall-clock deadline is not a guaranteed billing cutoff; the subprocess deadline and idle stop provide additional bounds, and observed overruns must be reported. [Container interface](https://developers.cloudflare.com/containers/reference/container-class/)

The processor never reads D1 directly. Each claim, heartbeat, and completion passes through the machine-authenticated Worker and is fenced by run token, job lease, and source revision. It receives short-lived GET/HEAD access for the assigned original and PUT access for the allowed poster; neither permanent source credentials nor backup access enters the container. Renewal and expired URLs are tested failure paths. No FUSE mount, durable library mirror, dedicated broker, Redis, or Kubernetes is needed.

### Storage adapter boundary

The adapter is explicitly required for future S3 support. Keep it to operations actually used:

- List a scoped prefix with a continuation cursor and normalized object records.
- Read object metadata and validate a source revision.
- Open a conditional byte-range stream with relevant response metadata.
- Issue short-lived, object-scoped processor read/write access where supported.
- Write a generated artifact to the configured derivative store.

Keep source reads and artifact writes separately credentialed. There is no source delete, rename, copy, migration engine, plugin loader, or provider-discovery framework.

Use R2's S3-compatible endpoint with read-only source credentials where strict read-only enforcement is needed; the browser never receives those credentials. Keep endpoint/region/signing details inside the adapter. AWS S3 implementation remains later work; S3 compatibility does not mean every provider feature is identical. [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

### Authentication and sharing

Use Cloudflare Access for initial web identity. The Worker validates the signed assertion and expected audience/issuer, then resolves an enabled application user and checks a D1 library grant. Identity admission alone never means access to all media. Configure Access to admit intended users; unknown application users receive no libraries. [Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

Bootstrap the first owner through deployment configuration plus Access admission. For another viewer, the operator updates the Access policy through Cloudflare's control plane; the owner then creates/enables the matching D1 user and grants libraries. The UI distinguishes admission instructions, application enablement, and grants; adding a D1 email is not a claim that the upstream policy changed. Initial identity linking requires the expected verified email; subsequent requests use the validated stable identity mapping. No automatic role promotion or grant inheritance on identity changes.

Display the signed-in account and provide Sign Out. Stop/unload the player, discard unsent account-bound writes and late responses, and clear private UI/query state before redirecting to `/cdn-cgi/access/logout`. Revalidate identity on account change, tab return, or restored browser navigation before displaying cached data. Test multi-tab transitions. Managed logout may affect other Access applications and does not promise logout from the underlying identity provider; provide a tested account-selection path. Access documents a short token-revocation delay, so immediate disabling is enforced separately by the D1 user flag on every protected request. [Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

Owner actions add/disable users and grant/revoke existing libraries. Viewer grants are read-only. Source credentials and infrastructure changes remain deployment operations. The machine processor has separate authentication and only job-scoped endpoints; it never impersonates a viewer or receives a general database token. A machine callback must not depend on interactive Access login; its dedicated Worker handler validates the machine credential and current job/run lease, with the browser Access policy configured accordingly. All browser routes remain protected.

Authorization also checks that the enabled library's immutable source and exact folder prefix contain the resolved object. Granting `family/` must never admit `family-private/`. Disabling a library denies its existing catalog rows immediately; changing a display name cannot change scope.

## 7. Catalog, scan, and job invariants

### Minimum logical data model

This is a conceptual model, not a mandated ORM or final SQL schema.

| Record | Essential fields / constraints |
| --- | --- |
| Source | ID, provider, endpoint/bucket reference, configured allowed scope, credential reference; no raw secrets in catalog exports |
| Library | ID, source ID, name, exact prefix, enabled state, scan schedule |
| User | ID, verified identity mapping, role, enabled state |
| Library grant | Unique user/library pair |
| Video | Stable ID, source ID, exact key, library ID, parent path, filename, bytes, modified time, revision fingerprint, first/last seen, availability, probe/poster states, nullable technical metadata |
| User-video state | Unique user/video pair, favorite, watched flag, position, last watched, playback source revision, active playback-session generation/sequence |
| Scan run | Library/configuration version, status, cursor, lease, counters, start/completion times, error summary |
| Media job | Video ID, expected revision, job kind/version, state, lease token/expiry, attempt count, retry-after, error, output key |
| Processor run | Singleton active slot, run token/expiry, hard deadline, cumulative usage/budget, last heartbeat; jobs additionally require their own lease |

Do not add a physical folders table initially. Derive parent path at ingestion and query virtual descendants from the indexed catalog. Reconsider materialized folder records only if real browsing benchmarks need them.

### Safe discovery and reconciliation

1. At most one active scan per library, with paused runs occupying that slot until explicitly resumed or cancelled. Snapshot its configuration version; a disabled library or invalidated run cannot reconcile missing objects. Source/prefix cannot be changed after scanning begins in v1.
2. List a bounded page, upsert its objects, enqueue changed/new work, and persist its cursor atomically or with replay-safe ordering. Commit data before advancing the cursor.
3. Follow the provider continuation marker, not page length. A short page is not necessarily the last page.
4. Treat file extensions/content type as candidate hints, not proof of valid media. Expose non-video, unsupported-by-processor, or invalid results rather than crashing the scan; none is a universal browser-compatibility verdict. File types to include are configurable after the inventory sample.
5. Use key + size + modified time + provider revision evidence to detect change. ETags are opaque validators, not guaranteed MD5 content hashes, especially for multipart objects.
6. Only a successfully exhausted listing can begin missing-object reconciliation. Confirm candidates with an exact metadata read; authorization/timeouts are errors, not absence.
7. Mark confirmed absent objects unavailable, retaining their ID and user state. Do not delete source objects or erase history. A rename is a new key plus a missing old key; automatic history matching is not promised.
8. Re-listing is not a multi-page snapshot. Concurrent bucket changes may need the next scan; report scan interval/freshness honestly.

Workers Cron Triggers provide continuation. A provisional one-minute tick starts due daily runs, resumes active non-paused runs, and advances only a bounded number of pages within an explicit Worker CPU/wall-time allowance. Manual Start/Resume records durable intent and may do one initial step; closing its browser cannot stop later ticks. Lease each bounded step, persist counters/checkpoints, and release or expire the lease on interruption. Select active libraries fairly so one large prefix cannot starve the others. A missed tick delays work until a later tick; it never causes a cursor to be skipped or a paused run to restart. Report heartbeat age and stalled/overdue status. Cron is a scheduling mechanism, not an exactly-once guarantee.

R2 documents paginated listings and strongly consistent individual operations. The checkpoint and reconciliation rules above are our application design for safe recovery. [R2 listing API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)

### Safe enrichment

- Claim jobs using an atomic conditional lease, with a unique token and expiry; heartbeat long jobs. Duplicate delivery or overlapping processor runs must not create duplicate logical results.
- Read only the assigned source object. Restrict FFmpeg protocols/URLs to the generated object access path, avoid shell interpolation, and bound subprocess time, memory, output, and retries.
- Validate the expected source revision before processing and again before publishing. If it changed, discard the stale result and enqueue the current revision. Use conditional reads where supported.
- Upload a deterministic/versioned artifact before marking its reference ready. A retry may reuse the same artifact; incomplete writes never become the active poster.
- Stale jobs cannot overwrite current poster/metadata. Poster keys include video ID, source revision, and processing version.
- Thumbnail failure is independent of original playback. Probe failure is not proof that every browser will reject the original.
- Scheduled retries use bounded backoff; terminal failures remain actionable. No infinite retry loop or silent batch-wide failure.
- Generated orphan cleanup is separately scoped to the derivative bucket and only after confirming no active reference; it never touches the source bucket.

## 8. Streaming contract and security

- Use a native HTML video element with controls, inline mobile playback, and metadata preload. Do not preload full videos on the grid or force autoplay on navigation.
- Media and poster routes take a catalog ID, resolve its authorized source internally, and never accept an arbitrary upstream URL.
- Support full GET, HEAD, and single byte ranges, including open-ended and suffix ranges. Return correct 200/206/416 status, Content-Length, Content-Range, Content-Type, and Accept-Ranges. Define safe behavior for malformed/multiple ranges and test it explicitly.
- Honor relevant conditional validators; cancel upstream work on disconnect. Stream with backpressure and never use a whole-file buffer.
- Validate the catalog's source revision when opening a stream. A replacement mismatch requests catalog refresh and rejects stale progress updates rather than serving new bytes under old playback state; show a retryable changed-file message.
- A valid container extension alone does not establish compatibility. Actual video/audio codecs, profile, browser, OS, and hardware matter. Broadly supported H.264/AAC MP4 is a useful test baseline, not a guarantee for all MP4 files. [Browser codec guidance](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)
- Compatibility hints are scoped to the tested browser/device and source revision: likely compatible, confirmed unsupported here, or unknown. A probe result records technical facts, not a universal playback verdict. On a coarse native media error, make a bounded authenticated session/availability check before choosing a message. Handle Access's redirect/HTML response as well as explicit 401/403; the video element cannot supply custom diagnostic headers or reliably identify an expired session. Reauthenticate with a full-page flow when needed, resume only the same account/revision from its last saved position, and leave unexplained decode failures as "Playback failed on this device." Never globally flag the object unsupported from one failure. [Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- Progressive byte-range playback is not adaptive bitrate. Slow connections may buffer; no automatic low-bandwidth rendition exists in v1.
- Authorize every request, including thumbnails, media ranges, counts, search, history, and owner operations. Do not put private responses into a public/shared cache. Begin with private/no-store responses; optimize only after access-isolation tests.
- The application can revoke future requests, not bytes already delivered or an in-flight response. It cannot prevent an authorized viewer from retaining received media.
- Processor presigned URLs are short-lived bearer credentials. Redact query strings from logs; renew access when necessary. They use the R2 S3 endpoint; they are not public sharing links. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- Protect state-changing endpoints against CSRF, escape untrusted filenames, enforce size/type bounds on inputs, and use parameterized SQL. Return no restricted filenames or bucket paths in unauthorized errors.

## 9. Performance, reliability, and cost requirements

### Provisional release targets

These are test targets, not measured claims. Baseline: 10,000 catalog videos, five active users, and three concurrent compatible streams. Replace this fixture with a larger one if the real inventory exceeds it.

| Area | Target / measurement |
| --- | --- |
| Library/folder API | Warm p95 under 500 ms, excluding client network; bounded page size, no per-card source reads |
| Filename/path search | Warm p95 under 1 second at the baseline, with authorization applied |
| First catalog results | Visible immediately after the first page commits; enrichment never blocks listing |
| Playback | Start within 5 seconds on the declared compatible sample/network test; record source bitrate and network conditions |
| Seeking | Correct playback at start/middle/end with ranged reads; do not download intervening bytes solely to seek |
| Progress | Resume within 15 seconds of the last successfully saved position |
| Processing | Every candidate reaches a ready, pending, or explicit failure state; no guessed full-backfill completion time |
| Isolation | Zero cross-user/library leaks in metadata, images, search, counts, or video tests |
| Recovery | A terminated scan/job resumes safely; provisional backup RPO at most 24 hours and restore RTO within 4 hours of operator action, measured in a drill |
| Accessibility | Keyboard-operable navigation and controls; visible focus, labels, contrast, and usable mobile layouts |

For initial enrichment, report success rate on supported fixtures and separately report unsupported/corrupt files. A placeholder is graceful degradation, not a successfully generated thumbnail.

### Backup and operator recovery

- Use D1 Time Travel for point-in-time recovery. Workers Paid currently retains 30 days; restore overwrites that database in place and is not a clone-to-new-database feature. Account access and the provider control plane must still be available. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- Produce one successful, consistent SQL export per day and before migrations, retaining 30 daily copies in a separate private R2 backup bucket. Use the provider export API from bounded scheduled Worker steps, persist its polling bookmark/manifest in the backup bucket, and mark a backup complete only after its bytes, schema version, timestamp, and checksum are stored. Recovery state must not live only in D1. Keep source, poster, and backup credentials/scopes separate; media processors cannot access backups.
- The SQL export contains canonical catalog, identity mapping, grants, favorites, and viewing state; secrets remain in deployment secret storage. No FTS virtual tables exist in v1. D1 exports block other database requests: drain/stop enrichment and suppress scan work/new claims before exporting, then resume only after export completion; otherwise normal export blocking can expire healthy job leases. Choose a low-traffic window, measure its duration, expose planned maintenance, and test bounded client retries. If the pause is unacceptable, change the backup method before launch. [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- Default acceptable data loss (RPO) is at most 24 hours of application state, conditional on a successful daily copy; the provisional recovery-time target (RTO) is four hours after an operator begins recovery. The owner must accept these before release. A backup older than 24 hours is a failed target, not silently compliant: expose age in R2 manifests and operational logs, with a Cloudflare monitoring alert independent of the owner UI. Verify alert delivery during the recovery drill.
- For both Time Travel and export-based restoration, enable an operator-controlled maintenance gate outside D1: deny viewer/machine requests, stop schedules, and stop active processing before restoration. After either path, invalidate run/job/playback leases and reconcile authorization before reopening. If current grants cannot be recovered independently, disable restored viewers/grants until explicit owner reapproval; Access admission alone cannot prove that a library grant was not revoked after the backup.
- Maintain an operator runbook and deployment identifiers outside the application database. Using independent Cloudflare operator credentials, restore an export to a new isolated D1 database, check schema/counts and user state, reset all run/job/playback leases, and reconcile restored users/grants with current authorization before switching the binding. A restore must not silently re-enable a revoked viewer. Test the process while the owner UI is unavailable. Stop schedules during cutover and resume only after verification.
- R2 originals are not duplicated by this application backup. Posters are regenerable; absent poster objects after restore use placeholders. Access policies, secret references, and deployment configuration need a separate operator-held configuration record. Same-account R2 backups are not an independent-provider disaster-recovery guarantee; account-wide loss remains a documented limitation.

### Cost model

Existing source storage is already an expense; do not present it as a new duplicate-storage requirement. At the currently documented R2 Standard rate of $0.015/GB-month, an illustrative 100 GB is approximately $1.50/month before free allocation, or $1.35 if the account's full 10 GB allocation is available. This is an illustration, not the user's bill; units, storage class, account usage, and taxes may differ. R2 Internet egress is free, but requests, connected services, and Infrequent Access retrieval can incur charges. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

Incremental cost includes the Workers Paid plan, Worker requests/CPU, Durable Object requests/duration/storage, D1 reads/writes/storage, source list/read operations, Containers CPU/memory/disk, image storage, logs, artifact uploads/storage, and backups. D1 pricing is based on rows read/written and storage, so repeated unindexed catalog searches must be measured. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

Containers currently bills in 10 ms units: provisioned memory and disk while running, and active CPU use. The $5/month Workers Paid plan includes 25 GiB-hours of memory, 375 vCPU-minutes, and 200 GB-hours of disk per month; excess rates are $0.0000025/GiB-second, $0.000020/vCPU-second, and $0.00000007/GB-second respectively. These are account-level allocations, not guaranteed spare capacity for this application. Add regional container egress and Worker/Durable Object/log charges. Do not infer free container-to-R2 traffic solely from one-provider placement; confirm its metering before estimating savings. [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)

Do not promise a total monthly price until the sample establishes file count, typical bytes read per probe/poster, processing time, concurrency, and expected viewing hours. Project initial scan cost from measured per-file totals; show a range and failed-file retry budget. No bulk transcoding spend is part of v1.

## 10. Release phases and verification

| Phase | Deliverable | Exit criteria |
| --- | --- | --- |
| 0 — Validate inputs | Representative-sample working flow: R2 scan → D1 catalog → Container-generated thumbnails → browse/play/seek | Demonstrate the integrated flow and isolation between two users with disjoint library grants. Measure playback including audio/seeking, thumbnail yield, resource use, retries, shutdown, and projected cost. Owner accepts the browser/device coverage, resource limits, cost range and spending ceiling, plus non-overlapping library prefixes before the first scan, including the root-library restriction. Sample results do not guarantee the entire collection. |
| 1 — Catalog and access | R2 connection, resumable scan, D1 catalog, users/library grants, both views, filename/path search | Multi-page scan completes after the browser closes; pause survives daily scheduling; overlapping ticks are safe; admission and account switching pass; no unshared content or source mutation. |
| 2 — Play and enrich | Private ranged playback, FFmpeg jobs/posters, probe metadata, incompatibility states | End-to-end play/seek and poster generation on representative files; stale/failed jobs isolated; browser errors actionable. |
| 3 — Personal library and operations | Continue Watching, Recently Watched, Favorites, cross-device state, scheduled refresh, recovery | All P0 stories and isolation/recovery targets pass; owner accepts backup RPO/RTO and export maintenance; recovery succeeds without the app; actual inventory is reconciled and enrichment outcomes are reported. |
| Later | Selected P1 stories and eventually S3 | Prioritize from actual usage; no assumption of full Emby/Jellyfin parity. |

Required checks during implementation:

- A listing larger than one page, including a short non-final page, interrupted requests, duplicate pages, an expired cursor, and a permission failure. No failed run may clear the catalog.
- Close the browser immediately after the first scan checkpoint; later Cron ticks must finish. Overlap scheduled/manual triggers, expire a step lease, and pause across a daily start time; no duplicate active scan or pause bypass.
- Duplicate basenames, Unicode, spaces, `#`, `%`, `?`, mixed case, nested prefixes, and folder markers. Storage identity must remain exact; filenames must not become executable input.
- Add, overwrite, remove, and rename objects in an isolated test prefix; verify stale metadata invalidation and retained catalog/history rules.
- Replace a previously watched object at the same key: clear Recently Watched/position/watched for the replacement, preserve favorite, and reject a delayed update from the prior revision/tab.
- Compatible MP4, another browser-supported format, unsupported audio/video combination, portrait video, very short/long videos, a large object, and a corrupt/truncated fixture.
- Actual byte-range responses and player seeking on agreed desktop/mobile browsers. Test revoked access and expired login during playback.
- Two viewers with disjoint grants; guessing video IDs, search terms, poster URLs, counts, and history endpoints must not disclose the other library.
- Test Access admission without a D1 grant, a D1 user/grant without Access admission, disabled users with an existing session, logout, and a second-account login in the same browser. Late responses, unsent writes, other tabs, and browser-back restoration cannot reveal the prior account's state.
- Folder-boundary grants such as `family/` versus `family-private/`; reject scope edits after scanning starts and deny all reads immediately when a library is disabled.
- Terminate the processor while probing, after upload, and before completion. Retry must not publish stale metadata or duplicate state.
- Measure cold start, peak RAM/scratch, active CPU, total wall time, range counts/bytes, upload bytes, and cost per successful and failed video. Exercise signed URL expiry, OOM/restart, stalled heartbeats, overlapping dispatch, exhausted budgets, upload failure, and delayed callbacks. Confirm idle/overdue instances stop and metered usage reflects shutdown; record any deadline overrun.
- Export and restore into a separate D1 database while the owner UI is unavailable. Compare canonical records, verify a revoked user stays denied after current-policy reconciliation, invalidate restored leases, and test stale-backup alerts. Measure export blocking and recovery duration; R2 listing alone cannot recover user state.

Use the recovery process in section 9. If FTS5 is introduced later, retain rebuildable search data and validate a new consistent canonical-record export path: D1 currently documents export limitations for databases containing virtual tables. Never drop a production search table as a routine backup step. [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)

## 11. Emby/Jellyfin feature disposition

This maps the complete preceding comparison into this product rather than silently losing features.

| Earlier feature | Embyfin disposition |
| --- | --- |
| Browse a library | LIB-01 |
| Search and filter | LIB-07 through LIB-09 |
| View title details | LIB-10; commercial movie enrichment is OUT-01 |
| Navigate TV shows | LIB-06 preserves folders; automatic seasons are OUT-02 |
| Personalize home screen | LIB-02 through LIB-05; configurable layout is FUT-13 |
| Save favorites | LIB-05 |
| Watch across devices | LIB-11 and PLAY-01/03; native apps deferred under FUT-09 |
| Resume playback | PLAY-03 |
| Continue a series | FUT-03; no inferred television structure |
| Track watched content | PLAY-04 |
| Choose languages | FUT-08 |
| Watch away from home | PLAY-07 |
| Cast/control another device | FUT-09 |
| Browse music | OUT-03 |
| Create music playlists | OUT-03; video playlists are FUT-02 |
| View personal photos | OUT-04 |
| Read books/comics | OUT-05 |
| Separate accounts | ACC-01 and ACC-03 |
| Restrict library access | ACC-02 |
| Filter children's content | FUT-12; basic library separation is ACC-02 |
| Set viewing hours | FUT-12 |
| Control permissions | ACC-02/04 and OPS-01; original deletion is deliberately unavailable |
| Offline viewing | FUT-04; no managed sync in v1 |
| Skip intros | FUT-15 |
| Live TV | OUT-06 |
| Record TV | OUT-07 |
| Watch together remotely | FUT-11 |
| Easier device sign-in | ACC-01 for web; FUT-14 for TV |

Feature inspiration: [Emby overview](https://emby.media/), [Emby feature matrix](https://support.emby.media/support/articles/Premiere-Feature-Matrix.html), [Jellyfin overview](https://jellyfin.org/), [Jellyfin user management](https://jellyfin.org/docs/general/server/users/adding-managing-users/). These are comparison sources, not dependencies or promises of client compatibility.

## 12. Remaining implementation inputs and decisions

No answer is needed to review this PRD. Before building or provisioning, establish:

1. Actual file count, total bytes, largest file, extensions/codecs, and source storage class. Total bytes alone do not size compute or the catalog.
2. Which prefixes form shareable libraries, and which initial users should see each. Reject overlapping scopes in v1 rather than infer permission precedence.
3. Target browsers/devices and a representative read-only sample. Report per-device playable fraction with its sample denominator and coverage limits, and obtain owner acceptance rather than invent a universal target.
4. Frequency of new uploads/replacements. Daily scan starts, one-minute continuation/dispatch ticks, and 15-minute enrichment cadence are provisional defaults.
5. Workers Paid/Containers availability in the account, suitable instance size, placement/network metering, final measured per-job limits, and a spending ceiling. No instance is provisioned or workload-verified.
6. Domain, managed identity admission, and secret delivery. Obtain these through deployment configuration, not by putting secrets or real media paths into this PRD.
7. Acceptance of the provisional 24-hour RPO/four-hour RTO, export maintenance window, independent operator recovery credentials, and delivery of backup-failure alerts. Confirm the boundary of same-account disaster recovery.

Cloudflare-only compute is now the chosen baseline to validate. If universal playback, public sharing, or zero temporary scratch becomes required, revise the architecture and acceptance criteria explicitly. Failed processor acceptance triggers a documented alternative assessment, not a silent switch to another cloud.

## 13. Review decisions and provenance

All six committee recommendation groups are adopted. They close correctness or operability gaps without adding transcoding, public links, movie enrichment, or a second catalog.

| Recommendation | Decision and reason | Requirement location |
| --- | --- | --- |
| Cloudflare-only processor | Adopt Containers as default candidate; a native processor need not require a second provider. Add lifecycle/resource controls rather than merely rename the host. | Section 6; OPS-03; phase 0 |
| Complete account lifecycle | Adopt; Access admission and application grants are separate gates, and shared devices need explicit cleanup/account switching. | ACC-01/05; Journeys D/E; section 6 |
| Honest playback failures | Adopt; a native player error cannot establish universal incompatibility or distinguish an expired login by itself. | PLAY-05/06; section 8 |
| Unattended scan continuation | Adopt Cron continuation; stored cursors alone do not cause further execution. | ING-05; OPS-04; section 7 |
| Independent recovery | Adopt daily/30-day backup defaults, explicit RPO/RTO, and operator recovery outside the app; the component being recovered cannot be the only recovery interface. | OPS-02; section 9 |
| Revision-aware recent activity | Adopt; a same-key replacement must not inherit viewing activity for old content. | LIB-03; PLAY-04; section 5 |
| Phase-zero acceptance | Adopt measured browser/playable coverage and prefix-sharing acceptance; passing a few fixtures is not sufficient evidence that the product serves this collection. | ING-02; sections 10/12 |

Provider capabilities were rechecked against official documentation on 2026-09-10, using Context7 before supplemental browsing. Native reviews examined the original committee findings and the Container lifecycle/limits/costs. Sources are linked beside the relevant decisions. Actual inventory, runtime tests and deployment history belong in the private acceptance record; this PRD does not certify a deployment.

The initial Fable 5.1 attempt failed with `API Error: 400 unknown provider for model claude-fable-5.1`. During this revision, Claude Code readiness succeeded but automatic approval review rejected the consultation before model launch because it could export private PRD/repository contents to an external Claude service. No Fable advice informed this revision; the updated baseline is based on documented capabilities, native reviews, and the confirmed requirements.
