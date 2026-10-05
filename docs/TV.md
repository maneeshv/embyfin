# TV shows and episodes

TV libraries organize original video files into shows, seasons and episodes. Ordinary Videos and Movies libraries keep their existing behavior; TV metadata and subtitles are optional. All pages and artwork use the same library grants as original playback.

## Setup and identification

Apply numbered migrations through `0004_tv.sql` before serving this version. `npm run db:migrate` applies them to the isolated local database. Production migration and release remain operator actions under the deployment runbook. The migration expands the library type constraint while preserving library IDs, grants, videos and movie matches; it does not rebuild the referenced libraries table.

Configure a TMDB API Read Access Token in **Settings → Metadata and subtitle providers**. Existing `TMDB_READ_TOKEN` Worker secrets remain a fallback until the owner saves or disconnects TMDB in Settings. Then select **TV shows** as the library type in Settings. Existing libraries keep their current type. Background identification handles up to three eligible TV files per tick in addition to the movie batch, independently of FFmpeg processing.

Supported names identify one episode explicitly:

- `Example Show (2020) S01E02.mkv`
- `Example.Show.1x02.mp4`
- `Example Show/Season 01/S01E02.mkv`
- `Example Show/Specials/S00E01.mkv` for season zero

The title and optional first-air year must match a unique TMDB show. Ambiguous show names, multi-episode files, date-only names and absolute episode numbering remain unmatched. Failed or unmatched background attempts retry after a day. The owner can search for a show, specify season and episode numbers, choose a match, retry, or clear it. Manual identification also works in mixed Videos libraries. Selecting a movie for an episode file, or an episode for a movie file, replaces the previous classification atomically.

## Browsing and playback

The TV shows page groups matched files by show. Open a show to select a season, including Specials, and browse its episodes in numerical order. Unmatched TV files remain accessible from that page and from the ordinary catalog/folders. Missing metadata never prevents playing the original.

Episode pages show the title, description, air date, still artwork and cast when available. Previous/next links navigate distinct available episodes within that show, across season boundaries; duplicate copies of the same episode do not become the next episode. Playback starts explicitly and preserves the existing per-user progress and watched state. There is no automatic next-episode playback or transcoding.

Cast links include authorized movies and episodes already stored in this catalog. Show and season counts, actor pages and navigation exclude unavailable or unauthorized files. This is a view of the local collection, not an external episode guide or streaming filmography.

## Subtitles, privacy and limits

OpenSubtitles uses the API key and account username/password saved in Settings, with automatic token renewal described in [Movies and subtitles](MOVIES.md); deployment-provided Worker secrets remain a fallback until the owner saves or disconnects OpenSubtitles. No separate TV provider account or login token is needed. Imports remain explicit. For an identified episode, search uses the TMDB **show** ID plus the exact season and episode numbers. An entered title override searches that title with the episode numbers. Manual movie matches keep movie subtitle search even when the containing library is TV. Imported tracks and the Off/language selector use the existing native player without restarting playback.

Identification sends the parsed show title, optional year and episode numbers to TMDB. It does not send original media or source object keys. Metadata and at most 30 cast members per episode are stored in D1. API responses and artwork retain the existing time/size limits and same-origin authenticated routes. Show cast is derived from the authorized episodes present in the catalog; guest cast may differ between episodes.

Replacing an original invalidates its episode match and imported subtitles. SQL exports include show, episode and cast records; restore older backups with all missing migrations before using this version. Provider credentials saved in Settings are encrypted in the existing controller's private Durable Object storage and are not part of SQL exports. Tests use synthetic providers and do not establish a live account's access, download quota or subtitle timing.

Provider contracts: [TMDB show search](https://developer.themoviedb.org/reference/search-tv), [episode details](https://developer.themoviedb.org/reference/tv-episode-details), [episode credits](https://developer.themoviedb.org/reference/tv-episode-credits), and [OpenSubtitles series/episode filtering](https://forum.opensubtitles.com/t/getting-no-results-since-a-couple-of-days/2515). TMDB attribution remains visible in the UI.
