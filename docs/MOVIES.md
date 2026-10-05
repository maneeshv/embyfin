# Movies and subtitles

Movie support extends the existing private catalog and original-file player. It does not write to the source bucket or transcode media.

## Behavior

1. Movies libraries identify files automatically from their names and retain revision-bound TMDB metadata and cast. Only a unique exact title/year match is automatic; the owner can correct or clear matches.
2. OpenSubtitles search and explicit imports provide native WebVTT tracks. Imported subtitles live with catalog data; acquiring a subtitle is an explicit user action because provider downloads have quotas.
3. The native UI provides movie posters/details, cast navigation and subtitle controls alongside ordinary videos, folder browsing, account cleanup and playback progress.
4. Tests cover provider failures, authorization, replacement invalidation and UI behavior. Providers use synthetic fixtures in tests; live setup and deployment remain operator actions.

The implementation uses optional server-side provider credentials and no new runtime dependencies. External API URLs are fixed; the browser receives authenticated same-origin artwork and subtitle URLs.

## Setup

Apply local migrations with `npm run db:migrate`. For a production upgrade, the operator must first verify a current backup, apply the new numbered migrations to the intended database and release the Worker through the existing deployment runbook. Agents must not deploy.

The owner can configure TMDB in **Settings → Metadata and subtitle providers** by entering a TMDB API Read Access Token, then choosing **Save and test connection**. OpenSubtitles can be configured there with its API key, account username and password. The fields are write-only: saved values are never returned to the browser. Saving first validates the new credentials; a failed check leaves the previous configuration in place. **Test connection** checks the saved credentials. **Disconnect** turns off the saved configuration; when deployment fallback values exist, it explicitly turns those off too. Register an application in [OpenSubtitles API Consumers](https://www.opensubtitles.com/en/consumers) for its API key.

Settings requires the operator to provision `PROVIDER_ENCRYPTION_KEY` as a Worker secret before it can save provider credentials. Generate 32 random bytes and encode them as base64, for example with Python's standard library: `python3 -c 'import base64,secrets; print(base64.b64encode(secrets.token_bytes(32)).decode())'`. Add the resulting value as a **Secret** under Workers & Pages → the application Worker → Settings → Variables and Secrets, then deploy. Keep the key in the operator vault and use the same key for every release. Losing it makes saved credentials unreadable; restore the original key or disconnect and enter the provider credentials again. Do not rotate it casually.

Existing `TMDB_READ_TOKEN` and OpenSubtitles Worker secrets remain supported as deployment-provided fallback credentials until the owner saves or disconnects that provider in Settings. Saved Settings take precedence. Disconnect deliberately disables the fallback for that provider. Cloudflare is needed to provision the encryption key and for deployment-level fallback credentials, but routine provider setup and changes happen in the app.

Existing libraries remain Videos until the owner changes their kind in Settings. Cron identifies up to three available files per tick in Movies libraries, independently of FFmpeg processing. Use descriptive names such as `Example Movie (2020).mkv`. Ambiguous or unrecognized names remain unmatched; the owner can search, select a match, retry identification, or dismiss a match. A video in a mixed library can also be matched manually. Failed/unmatched automatic lookups retry after a day. Nothing contacts TMDB when the credential is absent.

Subtitle search and imports use the credentials saved in Settings or the deployment fallback. No manually generated login token is needed. An optional `OPENSUBTITLES_USER_AGENT` deployment variable identifies the registered application.

The Worker logs in on demand, shares the session through the existing MediaController Durable Object and renews it before expiry. A provider `401` triggers one renewal and one retry; requests do not keep retrying invalid credentials or exhausted quotas. The provider's official API or VIP API host is selected from its login response. A complete username/password pair is required for automatic renewal. A legacy deployment `OPENSUBTITLES_TOKEN` remains supported when no account login pair is configured, but it must be replaced manually when it expires. Subtitle search and import are available when the saved or deployment-provided credentials are complete.

Subtitle search uses a matched movie's TMDB ID when no title override is entered. Downloading consumes the configured provider account's quota; renewal does not increase it. Importing an already stored file reuses it.

Search and select subtitles on a video's details page. Playback uses native WebVTT tracks with an Off option; imported tracks matching the browser language can be selected automatically. Subtitle selection does not require transcoding or restart playback. Imported tracks are shared with accounts authorized for that video, while watch progress and favorites remain personal.

## Data and limits

- Identification sends the parsed filename title and year to TMDB. Manual search sends the entered query. Movie library kind is the owner's opt-in for automatic lookups; source keys and media bytes are not sent to providers.
- Metadata and up to 30 cast members are stored in D1. Actor pages list authorized, available, matched movies and TV episodes already in this catalog, with pagination; they do not list an external filmography or infer the cast of unrecognized home videos.
- Artwork is fetched from TMDB through authenticated same-origin routes with a timeout and 5 MiB limit. Source-generated thumbnails remain the fallback. Provider errors leave original playback available.
- Subtitle imports request UTF-8 SRT, escape cue text, convert to WebVTT and store at most 256 KiB per track in D1. Archives, image subtitles and oversized text are not imported. External download links are restricted to `dl.opensubtitles.com` and `www.opensubtitles.com`; redirects, credentials and explicit ports are rejected. Search results come from the provider; users must choose the release/language that matches their file. A 60-second database reservation prevents simultaneous imports of the same track from spending the download quota twice. Failed imports release the reservation; interrupted imports can be retried after it expires.
- Replacing an original invalidates its movie match and subtitles. Disabling a library or removing a grant denies its movie details, cast and derived routes. Private browser caching follows the existing account-varying cache policy.
- Full D1 SQL exports include metadata, cast and subtitle content, but do not include provider credentials saved in Settings. Those credentials are AES-GCM encrypted in the existing MediaController Durable Object's private storage, separate from D1 and R2. Keep the encryption key and provider credentials in the operator vault; this application's D1/context backups do not export that Durable Object data. After disaster recovery, restore the original encryption key if the Durable Object data remains, or disconnect and re-enter the credentials in Settings. Apply any migrations absent from an older backup before running this version. `schema_info` remains the base recovery-format version; `d1_migrations` records additive schema changes.
- Cached subtitle login tokens stay in private Durable Object storage, outside D1 exports, browser responses and logs. Automatic renewal uses the saved or deployment-provided OpenSubtitles account credentials; invalid-login `401`/`403` failures are held until credentials change, transient provider failures back off, and login attempts enforce provider limits. Provider Settings add no D1 migration, service or dependency.
- [TV libraries](TV.md) add show/season organization and episode identification. Transcoding, external filmography streaming and subtitle synchronization editing are not included.

## Provider references and attribution

[TMDB authentication](https://developer.themoviedb.org/docs/authentication-application), [movie search](https://developer.themoviedb.org/reference/search-movie), [image URLs](https://developer.themoviedb.org/docs/image-basics), [approved logos](https://www.themoviedb.org/about/logos-attribution), and the [OpenSubtitles API specification](https://stoplight.io/api/v1/projects/opensubtitles/opensubtitles-api/nodes/open_api.json) define the integrations. `public/tmdb-logo.svg` is TMDB's unmodified approved blue short logo.

This product uses the TMDB API but is not endorsed or certified by TMDB. Subtitles are provided by OpenSubtitles. Operator credentials and provider quotas are required for live provider use; synthetic tests do not verify a live account's entitlements or subtitle timing for its media.
