# Embyfin agent guide

Shared instructions for every coding agent (Codex, Claude Code, and others that read `AGENTS.md`). `CLAUDE.md` is a symlink to this file; edit only this file.

Embyfin is a private video catalog over an existing R2 bucket: a Cloudflare Worker/API, a native browser UI, a D1 catalog, and a bounded FFmpeg container. [README.md](README.md) has the module map and local setup. [PRD.md](PRD.md) is the product spec. Deployment and recovery live in `docs/` and `infra/terraform/`.

## Skills

Skills live in `.agents/skills/<name>/SKILL.md` (Codex reads this directly; Claude Code reads it via the `.claude/skills` symlink). Two vendored sets, see `.agents/skills/README.md` for versions and update steps:

- **superpowers** (brainstorming, writing-plans, test-driven-development, systematic-debugging, verification-before-completion, requesting-code-review, finishing-a-development-branch, and more). Read `using-superpowers` at the start of a session and invoke a skill whenever one applies to the task in front of you.
- **ponytail** (`ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`). Default mode for all code changes: reuse what exists, prefer the standard library and platform, write the minimum that works, delete before adding.

In Claude Code the same skills are also available as plugins (`superpowers@claude-plugins-official`, `ponytail@ponytail`) enabled in `.claude/settings.json`. Plugin versions carry hooks; the vendored copies are the portable source of truth.

## Commands

```sh
npm ci                   # Node 22.13+, Python 3.9+, FFmpeg/FFprobe on PATH
npm run db:migrate       # local D1 migrations
npm run dev              # http://localhost:8787, signs in as owner@localhost
npm test                 # Node tests + processor and ops unittests (opens a loopback socket)
npm run check            # tsc, browser JS syntax, Python syntax
npm run build            # Worker dry-run compile, no deploy
npm run check:public     # scan the public tree for private identifiers and credentials
```

Local tests use in-memory SQLite and a loopback proxy and have no production access. Run them, fix failures caused by your change, and rerun without asking. Never run `npm run deploy`, `wrangler deploy`, `terraform apply`, or the backup commands from an agent session; those are operator actions.

## Repository rules

- **Public source, private context.** Installation inputs, account IDs, resource names, measurements, and operational history belong in ignored `.private/` files, never in tracked files. Public examples use synthetic values (all-zero account IDs, placeholder buckets). See [docs/PRIVATE-CONTEXT.md](docs/PRIVATE-CONTEXT.md).
- **No secrets in the tree.** `.dev.vars`, `.wrangler/*.env`, `wrangler.generated.json`, and Terraform state are ignored on purpose. Do not read credential files into context or print their contents.
- **Read-only source bucket.** Never add a delete, rename, copy, or write path against the source R2 bucket. Exact object keys are preserved as-is.
- **Fail closed.** Auth, grants, byte ranges, leases, and provider/source configuration changes reject on any doubt. Keep it that way.
- **Schema changes go in a new numbered file** under `migrations/`. Never edit an applied migration.
- **Processor safety.** `processor/main.py` runs one subprocess at a time with fixed FFmpeg arguments, format and protocol allowlists, and metered reads. Do not loosen these or add network demuxers.
- **Docs follow code.** Update `README.md`, `docs/ACCEPTANCE.md`, or the runbooks in the same change when behavior, commands, or checks change. Do not add installation-specific results to public docs.

## Coding standards

- **Languages.** Worker code is ES module JavaScript in `src/` with `src/index.ts` as the typed entrypoint (`strict`, `allowJs`). Browser UI is plain JS/CSS in `public/`. Processor and ops tooling are Python 3 standard library only.
- **No new dependencies** without a stated reason in the PR. The Worker has four runtime dependencies; the UI has none (no framework, no service worker, no client cache).
- **Style.** Two-space indent, single quotes, semicolons, compact one-line helpers where the existing file does that. Match the density of the file you are in rather than reformatting it.
- **Errors.** Throw `Problem(status, code)` via `fail()` from `src/core.js` with a stable `snake_case` code. Validate every request input with the `string`, `number`, `boolean`, `prefix`, and `body` helpers before use.
- **Database.** Use the `sql`, `one`, `all`, `run` helpers with bound parameters. Multi-statement writes go through `db.batch`. Store seconds since epoch as integers from `now()`.
- **Tests.** Node tests live in `test/*.test.js` using `node:test` and the in-memory D1 shim in `test/app.test.js`. Python tests are `unittest` files next to the code. Non-trivial logic ships with a test that fails when the logic breaks. Tests must not reach the network beyond loopback.
- **Comments** explain why, not what. Mark deliberate shortcuts with a `ponytail:` comment naming the ceiling and the upgrade path.

## Commit standard

- One logical change per commit. Commit only tracked, public-safe files; run `git status` and `git diff --stat` first.
- Subject: imperative mood, sentence case, no trailing period, at most 72 characters. Describe the outcome, not the activity. Existing history is the model: `Save playback progress when leaving the player`, `Show all authorized libraries on the Folders landing page`.
- Body (optional, wrapped at 72): why the change was needed and what was verified. Reference an issue or PR number when one exists.
- An agent-authored commit carries one `Co-Authored-By:` trailer naming the agent and nothing else: no emoji, no other bot trailers, no generated-by lines in the subject or body. Full agent disclosure goes in the PR description.
- Never amend, rebase, or force-push commits that are already on `origin`. Never commit on `main` directly; branch first.

## Raising a pull request

1. Branch from current `main`: `<agent>/<short-topic>` where agent is `codex`, `claude`, or your handle. Example: `codex/recovery-and-remote-state`.
2. Before opening: `npm test`, `npm run check`, `npm run build`, and `npm run check:public` all pass. Terraform changes also need `terraform fmt -check`, `terraform validate`, and `terraform test` in `infra/terraform`.
3. Push the branch and open the PR against `main`:

   ```sh
   git push -u origin <branch>
   gh pr create --base main --title "<commit-style subject>" --body-file pr.md
   ```

4. The body uses these sections, in this order (see PR #1 for a full example):
   - Lead paragraph: what the change does and why.
   - `### Changes`: bullet list of behavior and file-level changes.
   - `### Validation`: exact checks that ran and their results (counts of tests passed, dry-run outcome, any live plan). Say what was not run.
   - `### Remaining steps and limits`: what still needs operator action, and what local checks do not establish (device coverage, Cloudflare costs, live Access, recovery objectives).
   - `### Agent disclosure`: model, harness, and skills or plugins used, or "written by hand".
5. Keep the PR to one topic. Split unrelated changes. Do not open a PR whose diff you have not shown to the human partner.
6. Merge only after review. Squash is not required; the branch history is already one change per commit.
