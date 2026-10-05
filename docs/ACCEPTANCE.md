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

## Live installation

- Verify browser Access, owner bootstrap, two-user grant isolation and account switching.
- Start approved non-overlapping library scans; verify pagination, interruption/resume and scheduled continuation without a browser.
- Test representative media within explicit budgets. Record duration, resolution, poster delivery, CPU, memory, source bytes, failures and shutdown behavior.
- Confirm no claims outside the controlled sample; disable the sample and verify the instance stops before enabling the full queue.
- Verify aggregate processing outcomes separately from scan completion. Unsupported/corrupt or budget-limited jobs may fail while originals remain playable.

## Recovery

- Verify a current completed SQL backup's checksum and age independently of the app.
- Restore into an isolated database and verify catalog/personal-state counts and source keys.
- Invalidate old leases and reconcile current user/grant authorization before cutover.
- Measure export interruption and recovery time; verify stale-backup and absent-schedule notification delivery.
- Download and decrypt the configuration archive on a clean directory; regenerate deployment config against the existing backend without changing resources.

## Lessons retained from implementation

The processor uses an explicit `Embyfin-Processor/0.1` user agent on machine callbacks. Some edge requests using Python's default user agent were rejected before reaching application authentication; changing Access/WAF policies was unnecessary for that fix. Startup diagnostics distinguish HTTP failures, connection failures and container exits.

Folders previously silently selected the first authorized library. The landing page now exposes all authorized libraries. A short folder list is not by itself evidence of an incomplete scan.

Local checks do not establish real-device codec coverage, Cloudflare cold-start costs, metered shutdown, export blocking, successful alert delivery or recovery objectives. Record measured results and remaining gaps privately.
