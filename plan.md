# Open-source preparation and private deployment context

## Objective

Separate reusable project code and instructions from the private deployment record, back up that record to encrypted R2 storage, and publish a clean repository without the existing private history.

Hosting details currently appear in documentation, `wrangler.jsonc`, Terraform backend settings, import blocks, variable validation, and example inputs. This requires configuration cleanup as well as documentation cleanup.

This document is a plan; it does not indicate that the changes have been implemented.

## 1. Preserve the current installation before editing

Create a new private recovery checkpoint containing:

- Current deployment runbooks and acceptance records.
- Production Terraform inputs, backend configuration, and resource import IDs.
- Generated Wrangler configuration and current deployed image/version references.
- Current Terraform state snapshot.
- A Git bundle of the current private repository.
- Existing credential files, using the recovery archive's explicit allowlist.

Encrypt it using the existing age public key and upload it under a new timestamped `recovery/` key in the private state bucket.

Download it again and verify the encrypted file's checksum. Keep the previous checkpoint intact.

**Completion condition:** Current deployment context is preserved remotely before any tracked content is removed.

## 2. Establish the public/private file boundary

Use one ignored `.private/` directory for installation context. Keep credentials in their existing protected locations to avoid unnecessary migration.

| Public repository | Private deployment record |
|---|---|
| Generic deployment and recovery procedures | Actual account, domain, owner, and resource inventory |
| Terraform configuration and example inputs | Production inputs, backend location, import identifiers |
| Wrangler template and local development configuration | Generated production configuration and release references |
| Acceptance checklist and sanitized technical findings | Actual production measurements, sample IDs, and incident history |
| Archive/restore tooling | Recovery recipient, archive receipts, and verification history |

Suggested private layout:

```text
.private/
  deployment.md
  acceptance.md
  terraform.tfvars
  backend.hcl
  recovery-recipient.txt
  archive-receipts/
```

Use existing Terraform inputs as authoritative values wherever possible. Private prose should explain operational decisions and history rather than duplicate every configuration value.

**Completion condition:** Every removed hosting detail has an identified private home.

## 3. Make Terraform reusable without changing live resources

The current Terraform configuration is tied to this installation in several places.

Planned changes:

- Replace the account-specific backend configuration with a partial S3 backend; supply installation settings through `.private/backend.hcl`.
- Preserve the existing bucket, state key, endpoint, and locking settings for the live installation.
- Replace hard-coded import IDs with optional adoption inputs.
- Default a new installation to no imports; validate that adoption has all required identifiers.
- Replace production-specific account/domain validation with generic validation.
- Replace real values in `terraform.tfvars.example` with clearly synthetic examples.
- Parameterize deployment-specific bucket names and source settings.
- Preserve Terraform resource addresses, bucket map keys, and `prevent_destroy` protections.

The backend configuration change should reconnect to the same state object, not migrate or overwrite state.

**Completion condition:** A live Terraform plan shows no managed resource changes. Output changes, if any, are reviewed separately.

## 4. Separate Wrangler defaults from production values

Turn the tracked Wrangler configuration into a generic template, retaining application settings such as bindings, code paths, migrations, and container limits.

Generate production configuration using Terraform outputs and private inputs. Ensure the generator supplies all installation values, including:

- Account and application hostname.
- Access issuer and audience.
- Owner email.
- Source endpoint, bucket, and scope.
- Database and derived bucket identifiers.
- Installation-specific operational settings.

Update deployment commands to explicitly use the generated configuration and fail clearly when it is missing or contains placeholders.

Keep local development usable without production credentials. Preserve live processing settings and the current container image reference in the private record.

**Completion condition:** Generated production configuration matches the existing deployment, and a clean checkout can run local checks without private hosting details.

## 5. Rewrite public documentation

Update the README, Cloudflare runbook, recovery guide, Terraform guide, and acceptance documentation.

Public versions will retain:

- Setup steps and required permissions.
- Infrastructure ownership: Terraform versus Wrangler.
- Backup, restore, deployment, and troubleshooting procedures.
- Technical lessons from the processor and folder fixes.
- Verification checklists and known limitations.

Move installation-specific details into the private record, including personal email, domains, account/resource IDs, actual media sample identifiers, token expiry records, and exact recovery object locations.

Also inspect the PRD, diagrams and their generators, SVG metadata, images, fixtures, and repository links. Regenerate diagrams if their rendered content includes private details.

The age recipient is not a secret, but belongs in private installation configuration rather than the public project.

**Completion condition:** Public documentation stands on its own and contains no known identifiers from the live deployment.

## 6. Add repeatable encrypted context backups

Add a small operator command for backing up `.private/`, separate from the larger workstation recovery archive.

The command should:

1. Validate required files and use an explicit file allowlist.
2. Create a protected temporary archive.
3. Encrypt it with the configured public recipient.
4. Upload it to a new timestamped `deployment-context/` object.
5. Download and verify the encrypted bytes.
6. Record the object key, checksum, source revision, and verification status.
7. Clean up temporary plaintext on success or failure.

It must never include private decryption keys, recursively archive the workspace, overwrite older snapshots, or upload plaintext.

Run this after infrastructure/configuration changes and operational documentation updates. Refresh the larger recovery archive after credential rotations.

**Completion condition:** Updating and remotely preserving deployment context is one documented command.

## 7. Verify recovery from a clean directory

Exercise recovery without relying on the working checkout:

- Download the archive through independently authenticated Cloudflare access.
- Decrypt into a protected directory.
- Confirm private configuration and runbooks are complete.
- Reconnect to the existing Terraform backend.
- Generate production Wrangler configuration.
- Run a read-only Terraform plan.
- Confirm no deployment, SQL import, or old-state restoration is needed merely to recover the workstation.

Checksums confirm transfer integrity; they do not prove that the archive can be decrypted. Since only the owner has access to the private key in 1Password, the final decryption check needs owner participation.

Store a short bootstrap note in 1Password with the archive location and recovery procedure, so finding the backup does not depend on files inside it.

**Completion condition:** A replacement workstation can recover deployment context and prepare a redeployment.

## 8. Prepare a fresh public repository

Keep the existing repository private, with its history intact. Create the public candidate from an explicit export of sanitized tracked files, without copying `.git`, ignored files, credentials, or build artifacts.

Before publication:

- Scan the export for known hosting identifiers and credential patterns.
- Inspect images and other binary assets.
- Check author/committer metadata for personal information the owner wants withheld.
- Run application checks, tests, Terraform validation and mocked tests, and a build check.
- Review the staged public tree and its initial commit.
- Add an open-source license once the owner chooses one.

Do not transfer private issues, release artifacts, logs, or historical branches into the public repository.

**Completion condition:** A clean initial history contains only reviewed public material.

## 9. Prevent future reintroduction

Add a lightweight public check for credentials and obvious production values in example configuration. Run a separate private pre-publication check against actual deployment identifiers; do not commit those identifiers as a scanner denylist.

Document this maintenance sequence:

> Update private configuration → verify the change → upload an encrypted checkpoint → publish only sanitized project changes.

R2 provides recovery from workstation loss. An additional copy of the encrypted archive outside Cloudflare would also cover loss of access to that account; that is a separate optional step.

## Owner input

Most preparation can proceed using existing access and the public encryption key. Owner input is needed for:

- **Recovery verification:** Decrypt the new archive using the 1Password key.
- **Publication:** Choose the public repository name and license, and approve the reviewed publication candidate.

## Final deliverables and operational boundary

- A sanitized public project.
- A remotely preserved private deployment record.
- Repeatable backup/recovery commands.
- Evidence that existing infrastructure remains unchanged.

No production redeployment should be necessary for this cleanup. Preserve the original videos, existing recovery checkpoints, and unrelated Cloudflare resources throughout the work.

## Implementation status

- Public documentation and configuration are separated from private installation inputs.
- Original deployment records and source history were preserved before sanitization.
- Terraform uses a partial backend and optional input-driven adoption; existing resource addresses and deletion protection are unchanged.
- Deployment configuration is generated from a fresh plan and rejects pending infrastructure changes or incomplete values.
- Encrypted context/full-recovery commands and public scan/export tooling are implemented with runnable checks.
- Live verification found no managed resource changes; generated configuration matched the pre-change configuration.
- Changes are being submitted for review through a private repository PR. Public publication remains a separate owner-approved step.
- Remaining owner steps: decrypt the new checkpoint with the vault key, retain the bootstrap note in the vault, choose a license/repository name and approve publication. A complete replacement-workstation recovery drill remains pending that decryption check.
