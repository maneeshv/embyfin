# Private deployment context

Public source and documentation contain reusable defaults. Installation inputs and operational history belong in ignored `.private/`. Credentials remain in protected `.dev.vars` and `.wrangler/*.env` files or the operator vault. Never put the age private key inside these backup inputs.

## Private file layout

| File | Contents |
|---|---|
| `.private/deployment.md` | Resource inventory, current release/image references, credential scopes/expiry and operational decisions |
| `.private/acceptance.md` | Actual measurements, verification dates, incidents and remaining gaps |
| `.private/terraform.tfvars` | Authoritative installation inputs, optional adoption IDs and operational overrides |
| `.private/backend.hcl` | Credential-free remote state bucket/key/endpoint and locking options |
| `.private/recovery-recipient.txt` | Public age encryption recipient; private key remains in the vault |
| `.private/archive-config.json` | Archive destination: `endpoint` and `bucket` |
| `.private/identifiers.json` | JSON array of private identifiers for pre-publication scanning |
| `.private/archive-receipts/` | Uploaded object keys, hashes, included files and verification status |

Protect the directory with mode 0700 and files with mode 0600. Generated `wrangler.generated.json` is ignored and mode 0600 at the repository root so build paths resolve correctly. The private directory is an editable working copy, not the only backup.

## Initial setup for another operator

Follow the [Terraform guide](../infra/terraform/README.md) for backend/installation input templates. Create the private Markdown records and identifier array. Configure a standard R2 account endpoint and a private archive bucket in `archive-config.json`:

```json
{
  "endpoint": "https://00000000000000000000000000000000.r2.cloudflarestorage.com",
  "bucket": "your-private-state-bucket"
}
```

Replace both examples. State and archives can share the private state bucket under different prefixes. Do not use the application's expiring SQL-backup prefix, enable public domains or attach this bucket to the Worker. Use an existing age recipient if one is already safely retained. Otherwise create a key with `age-keygen`, save the private identity in the vault, and place only its public recipient in `.private/recovery-recipient.txt`. Do not regenerate a key merely because this checkout lacks its private half.

## Back up deployment context

Install age and use the project's installed Node dependencies. Load trusted S3 credential environment variables; the backup command does not read or print credential-file contents itself:

```sh
set -a
. .wrangler/terraform-backend.env
set +a
npm run backup:context
```

The explicit allowlist contains the seven context files above and prior JSON receipts. It excludes credentials, original media, SQL, Git history, state and private decryption keys. Uploads are client-encrypted before transmission, use a timestamp plus random suffix under `deployment-context/`, and use conditional creation to prevent overwrites. A download checksum check precedes the local receipt. Temporary plaintext is removed on ordinary success/failure; abrupt process termination or machine failure may leave a protected temporary directory that an operator should remove after inspection.

A receipt records the source HEAD and whether the working tree was dirty. A context archive does not include source changes merely because that flag is true. Refresh the full checkpoint when source recovery is also required.

The command never expires or deletes remote objects. Keep old checkpoints until replacements have passed recovery verification. It has no automatic schedule: run after infrastructure or operational-record changes. Transfer verification and decryption verification are recorded separately.

## Full workstation checkpoint

A full checkpoint also includes runtime/operator credentials, state, a Git bundle, the available preserved original files, and the current public working files (including the new operator tools). Keep the private originals as historical records. The working files preserve uncommitted implementation changes; the Git bundle contains committed history only.

Load both trusted credential files, then refresh the state snapshot and bundle before uploading:

```sh
umask 077
set -a
. .wrangler/terraform.env
. .wrangler/terraform-backend.env
set +a
terraform -chdir=infra/terraform state pull > .private/state.tfstate.tmp && mv .private/state.tfstate.tmp .private/state.tfstate
git bundle create .private/source.bundle --all
node ops/private-context.mjs recovery
```

Stop on any failed refresh. The recovery command requires these inputs; it does not pull state or silently substitute an old snapshot. Review the receipt's file list. Newly added untracked source files beyond the operator tools must be explicitly added to the recovery allowlist or tracked before relying on the checkpoint. Do not commit solely to make a backup when a review is pending.

## Replacement workstation

1. Retrieve the bootstrap note and age identity from the operator vault. The note should contain the Cloudflare account reference, private bucket/prefix, a verified checkpoint key/checksum and this procedure. Independent Cloudflare sign-in avoids depending on credentials that are inside the archive.
2. Download the chosen encrypted object from R2. Compare SHA-256 with the retained receipt/bootstrap note if available. Age authentication during decryption also checks ciphertext integrity; an upload checksum alone does not verify recoverability.
3. Store the identity temporarily in a protected file outside the repository. Never paste it into shell history. Decrypt into a new private directory:

   ```sh
   umask 077
   mkdir recovered
   age -d -i /path/to/protected-identity.txt -o recovered/context.tar.gz /path/to/checkpoint.tar.gz.age
   tar -tzf recovered/context.tar.gz
   tar -xzf recovered/context.tar.gz -C recovered
   ```

4. For a context-only archive, obtain reviewed source separately. For a full archive, recover committed history from `.private/source.bundle` if needed, then overlay the archived current source files; retain original files as history rather than overlaying them on current code.
5. Restore `.private/` and, for full recovery, credential files to corresponding paths with restrictive permissions. Install dependencies. Use the public Terraform guide to initialize against the current remote state and run `npm run config`. Do not push an archived state snapshot over a newer live backend.
6. Compare generated bindings and operational flags with the private deployment record. A workstation recovery requires no deployment, SQL import, migration or scan restart.
7. Record successful decryption and recovery verification in the private acceptance record and receipt, then upload a fresh context checkpoint. Remove the temporary identity and plaintext archive after verification.

Only the owner can verify the existing private key stored in 1Password. Until that check is performed, leave `decryptionVerifiedAt` unset. Retain older private keys as long as their archives are needed; changing the public recipient does not re-encrypt old objects.

These archives exclude original videos and catalog SQL. [Data recovery](RECOVERY.md) covers SQL separately. Same-account R2 storage protects against workstation loss, not account loss; an independent copy of the encrypted archive is an optional additional safeguard.

Provider credentials saved from owner Settings are encrypted in the existing MediaController Durable Object's private storage, not R2 or D1. The context and D1 backup workflows do not export those settings. Retain `PROVIDER_ENCRYPTION_KEY` and a way to re-enter TMDB/OpenSubtitles credentials in the operator vault. If Durable Object state is lost, restore the saved state with the original key where available; otherwise use Settings to disconnect and enter provider credentials again. Losing the key makes existing saved credentials unreadable.

## Public export and future changes

Keep the current private repository and its history private. Editing the working tree does not remove historical identifiers.

```sh
npm run check:public
python3 ops/check-public.py --identifiers .private/identifiers.json --export .private/public-export
```

The export directory must not exist. The command copies reviewed candidate working files without Git history, ignored files, symlinks or known sensitive values. It includes newly authored non-ignored files so an uncommitted review can be exported. Inspect that exact file list and all binary assets; pattern matching is not proof that a repository contains no secrets. Never publish the private denylist.

Before publication, choose a license and repository name, review commit author email/privacy settings, inspect the export, and create a fresh public history only after approval. Do not switch the existing repository to public or transfer its issues, releases, logs or historical branches.

For later changes: update private inputs/records, verify the change, upload an encrypted checkpoint, then publish only sanitized source. Run the generic public check for each release and the private identifier check before publication.
