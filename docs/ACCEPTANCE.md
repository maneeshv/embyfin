# Release acceptance checklist

Keep installation-specific results, sample identifiers, measured usage, resource versions and dates in `.private/acceptance.md`. This public checklist does not establish that a particular deployment has passed.

## Application checks

- Run `npm test`, `npm run check`, and `npm run build`.
- Run Terraform formatting, validation and mocked plan tests.
- Confirm Settings counts available enrichment states separately from missing videos and reports zero counts for empty libraries.
- Confirm the processor loopback proxy starts without hostname resolution and still passes the real FFmpeg round trip.
- Confirm Folders opens at all authorized libraries, library navigation retains breadcrumbs, global search respects grants, and switching libraries resets the previous folder.
- Confirm a second visit to a library page reuses cached posters (no poster requests in the Worker tail), a signed-out or different account cannot reuse them, and hidden-tab return revalidates the session without reloading the page.
- Check source replacement, exact-key handling, byte ranges, expired playback/run leases and disabled-user denial.
- Apply all numbered migrations locally and confirm existing libraries retain their type, IDs and grants. Set a library to Movies, verify exact title/year identification, unmatched/ambiguous states and owner match correction.
- Verify movie posters, backdrop and cast fallbacks; select a cast member and confirm only available files from authorized libraries are listed. Revoked grants and replaced originals must deny old artwork and subtitle routes.
- Search subtitles by movie/title and language, import explicitly, enable/disable/switch native tracks without resetting playback, and verify account switching clears the player. Verify malformed/oversized downloads and provider errors leave original playback usable.
- Set a library to TV shows; verify explicit S01E02/1x02 identification, season grouping, Specials, unmatched-file access and owner corrections. Multi-episode and ambiguous names must remain unmatched.
- Verify previous/next episode links skip duplicate copies, actor pages include permitted movies and episodes, and show counts/navigation reveal no unavailable or unauthorized titles. Confirm episode subtitle searches use the show ID and exact season/episode numbers, including season zero.
- Confirm ordinary videos and mixed-library manual matches retain the correct player and subtitle behavior; missing episode details must not hide Play.
- In owner Settings, save and test valid TMDB and OpenSubtitles credentials; verify saved values are write-only, blank edit fields preserve existing values, and failed replacements preserve the prior working credentials. Test the saved connections, then disconnect each provider and confirm deployment fallback credentials remain disabled. Confirm another account cannot update provider settings and cross-site requests fail CSRF checks.
- Verify provider credentials are encrypted in private Durable Object storage, absent from D1 exports and browser responses, and remain usable after a Worker restart. Missing, malformed or changed `PROVIDER_ENCRYPTION_KEY` must fail closed without overwriting stored credentials. Verify recovery by restoring the original key or disconnecting and re-entering provider credentials.

## Live installation

- Verify browser Access, owner bootstrap, two-user grant isolation and account switching.
- Start approved non-overlapping library scans; verify pagination, interruption/resume and scheduled continuation without a browser.
- Test representative media within explicit budgets. Record duration, resolution, poster delivery, CPU, memory, source bytes, failures and shutdown behavior.
- Confirm no claims outside the controlled sample; disable the sample and verify the instance stops before enabling the full queue.
- Verify aggregate processing outcomes separately from scan completion. Unsupported/corrupt or budget-limited jobs may fail while originals remain playable.
- With provider credentials configured in Settings, verify TMDB identification and OpenSubtitles search/import. Verify automatic login with an API key plus username/password, reuse across concurrent requests, renewal before expiry and a single renewal/retry after `401`. Incomplete login configuration must fail closed; saved settings must take precedence over deployment fallback credentials, and disconnect must disable that fallback. Check invalid-login suppression, transient backoff and quota failures without repeated downloads. Credentials and tokens must stay out of browser responses, logs and SQL exports. Check subtitle language, timing and browser support on representative media; fixture tests do not establish a live provider account's access.

## Recovery

- Verify a current completed SQL backup's checksum and age independently of the app.
- Restore into an isolated database and verify catalog/personal-state counts and source keys.
- Verify movie/episode matches, show metadata, cast and imported subtitles survive a new-schema export/restore; apply missing migrations when recovering an older backup before serving new code.
- Invalidate old leases and reconcile current user/grant authorization before cutover.
- Measure export interruption and recovery time; verify stale-backup and absent-schedule notification delivery.
- Download and decrypt the configuration archive on a clean directory; regenerate deployment config against the existing backend without changing resources.
- Confirm the operator vault retains `PROVIDER_ENCRYPTION_KEY` and a way to re-enter provider credentials. Provider settings in Durable Object storage are not included in the D1 or context archive recovery paths; account for credential re-entry if that state is lost.

## Lessons retained from implementation

The processor uses an explicit `Embyfin-Processor/0.1` user agent on machine callbacks. Some edge requests using Python's default user agent were rejected before reaching application authentication; changing Access/WAF policies was unnecessary for that fix. Startup diagnostics distinguish HTTP failures, connection failures and container exits.

Folders previously silently selected the first authorized library. The landing page now exposes all authorized libraries. A short folder list is not by itself evidence of an incomplete scan.

Local checks do not establish real-device codec coverage, Cloudflare cold-start costs, metered shutdown, export blocking, successful alert delivery or recovery objectives. Record measured results and remaining gaps privately.
