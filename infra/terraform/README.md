# Embyfin Terraform

Terraform manages D1, two derived R2 buckets, their disabled development URLs, and the browser/machine Access applications and policies. Wrangler owns Worker code, secrets, bindings, custom domain attachment, Cron, Containers and Durable Objects. Account billing, DNS zone, Zero Trust team, shared login provider, originals and state storage are prerequisites outside this stack.

Managed resources retain `prevent_destroy`. Removing their declarations or changing resources outside Terraform bypasses that protection. The originals bucket is never managed or written by this stack.

## Private inputs and backend

Use Terraform 1.10+ and the checked-in provider lockfile. From the repository root:

```sh
umask 077
mkdir -p .private
cp -n infra/terraform/terraform.tfvars.example .private/terraform.tfvars
cp -n infra/terraform/backend.hcl.example .private/backend.hcl
```

Replace examples with the intended installation values. The backend bucket must already exist, be private, have no public domains or expiration rule, and not be bound to the app. Keep its mutable state/lock objects free of retention locks. Each installation needs a distinct backend target; a separate checkout alone does not isolate state.

Credentials stay outside HCL. The Terraform operator token needs account-scoped D1 Edit, Workers R2 Storage Edit, and Access Apps and Policies Edit. Supply `CLOUDFLARE_API_TOKEN`; supply S3 backend credentials through `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. These are separate from Worker runtime secrets and Wrangler OAuth. Record scopes and expiry in the private operator record.

For existing trusted credential files only:

```sh
set -a
. .wrangler/terraform.env
. .wrangler/terraform-backend.env
set +a
terraform -chdir=infra/terraform init -backend-config=../../.private/backend.hcl
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform validate
terraform -chdir=infra/terraform plan -var-file=../../.private/terraform.tfvars -out=../../.private/infra.tfplan
```

When converting an already initialized checkout to this partial-backend layout, verify bucket/key/endpoint are identical, then use `init -reconfigure -backend-config=../../.private/backend.hcl`. This reconnects to the same remote state. Do not migrate, force-copy or push archived state over a newer backend. Native S3 lockfiles remain enabled by the backend example. Never force-unlock an active operator.

Review plans privately: plan files and outputs contain installation identifiers. Apply only the reviewed plan with `terraform -chdir=infra/terraform apply ../../.private/infra.tfplan`. No apply is needed merely to generate configuration when managed resources are unchanged.

## Adopt an existing installation

Set `adopt_existing=true` and all five `existing_resources` UUIDs in private tfvars. Imports use the supplied account and bucket names. Verify those identifiers against the intended account and hostname before planning; Terraform cannot infer whether an operator supplied the intended installation.

Adoption imports seven resources: D1, two buckets, two policies and two Access apps. The two managed-domain resources cannot be imported with the pinned provider: their initial creates set `enabled=false` on existing buckets' development URLs, without creating buckets or deleting objects. Public custom domains are separate and must also be checked.

People admitted through the Access dashboard must also appear in `viewer_emails`, or the next plan removes them. Resolve any unexpected changes before applying. Never accept resource replacements, deletion or a broadened Access policy during adoption. Import applies can also change configuration; they are not read-only. A subsequent plan should report no managed resource changes. Adoption does not require SQL migrations, new libraries or rescanning.

## New installation

1. Bootstrap a separate private backend and the account/zone/team/login prerequisites.
2. Fill private inputs; leave `adopt_existing=false`. Source credentials must be read-only. Source endpoint, bucket and scope are installation inputs, not inherited production defaults.
3. Plan and review. A fresh installation plans nine managed instances and no imports. Bucket, database and Worker names are configurable for separate installations.
4. Apply the reviewed plan and generate deployment configuration as below.
5. Apply migrations only to a confirmed empty catalog, using `DB` and the generated config. For recovery, follow the isolated restore procedure instead.
6. Deploy with runtime secrets, verify Access and source connection, then create approved libraries and start scans. Processing defaults off.

## Generate and deploy

```sh
npm run config
# Uses a fresh read-only plan and requires no managed changes or pending imports.
# Writes root wrangler.generated.json with mode 0600; never prints its values.
npm run deploy
```

`npm run deploy` regenerates first, then uses Wrangler's operator login with the infrastructure token removed from its environment. Run `wrangler login` separately if required. Root-relative paths retain the Worker, assets, migrations and Docker build context. `npm run build` checks the public template without a live deployment.

The generator combines current Terraform inputs/resources with the tracked `wrangler.jsonc` template, rather than trusting stale outputs from an earlier apply. It sets both database references, Access identity, source connection, and private operational overrides. Do not deploy the template or hand-edit generated files. Runtime secrets stay in Worker secret bindings; they are not Terraform inputs.

For the first deployment, generate configuration and use Wrangler with `--config wrangler.generated.json --secrets-file .dev.vars --keep-vars`. Clear `CLOUDFLARE_API_TOKEN` first if using OAuth. Routine releases reuse deployed secrets.

## Recovery when Terraform owns D1

Follow [data recovery](../../docs/RECOVERY.md) to create and verify an isolated restored database before cutover.

1. Back up current state securely. Update `database_name` and `existing_resources.catalog` in private tfvars to the verified restored database.
2. Remove only the old state association and import the restored database:

   ```sh
   terraform -chdir=infra/terraform state rm cloudflare_d1_database.catalog
   terraform -chdir=infra/terraform import -var-file=../../.private/terraform.tfvars cloudflare_d1_database.catalog 'ACCOUNT_ID/VERIFIED_RESTORED_DATABASE_ID'
   terraform -chdir=infra/terraform plan -var-file=../../.private/terraform.tfvars
   ```

3. Stop if the plan would recreate, rename or delete the restored database. `state rm` does not delete the old database; retain it until recovery is accepted.
4. Generate config and deploy while maintenance remains on. Complete identity/grant reconciliation and reopening checks from the recovery runbook.

Neither an infrastructure apply nor a Worker rollback restores data. [Encrypted context recovery](../../docs/PRIVATE-CONTEXT.md) covers workstation loss separately.

## Local verification

```sh
terraform -chdir=infra/terraform test
```

Mocked plan tests make no Cloudflare calls. They check private browser policy, the narrow machine path, disabled R2 development URLs, generated identity/source settings, no secrets in vars, and rejection of incomplete adoption inputs. Live verification belongs in the private acceptance record.
