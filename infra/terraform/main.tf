terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.24.0"
    }
  }
}

# Operator credential comes from CLOUDFLARE_API_TOKEN, never a runtime secret.
provider "cloudflare" {}

locals {
  wrangler = jsondecode(file("${path.module}/../../wrangler.jsonc"))
  buckets = {
    posters = var.poster_bucket_name
    backups = var.backup_bucket_name
  }
}

resource "cloudflare_d1_database" "catalog" {
  account_id       = var.account_id
  name             = var.database_name
  read_replication = { mode = "disabled" }

  lifecycle {
    prevent_destroy = true
  }
}

# The originals bucket and shared account resources are deliberately not managed.
resource "cloudflare_r2_bucket" "derived" {
  for_each      = local.buckets
  account_id    = var.account_id
  name          = each.value
  jurisdiction  = "default"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

# This provider resource cannot be imported. Its initial create sets enabled=false
# on the existing bucket; it does not create another bucket or delete objects.
resource "cloudflare_r2_managed_domain" "private" {
  for_each     = cloudflare_r2_bucket.derived
  account_id   = var.account_id
  bucket_name  = each.value.name
  jurisdiction = "default"
  enabled      = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "owner" {
  account_id       = var.account_id
  name             = "Embyfin owner"
  decision         = "allow"
  include          = [for e in distinct(concat([var.owner_email], var.viewer_emails)) : { email = { email = lower(e) } }]
  connection_rules = { rdp = {} }

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "processor" {
  account_id       = var.account_id
  name             = "Embyfin processor callbacks"
  decision         = "bypass"
  include          = [{ everyone = {} }]
  connection_rules = { rdp = {} }

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "browser" {
  account_id                 = var.account_id
  name                       = "Embyfin"
  type                       = "self_hosted"
  domain                     = var.hostname
  destinations               = [{ type = "public", uri = var.hostname }]
  session_duration           = "24h"
  allowed_idps               = [var.login_method_id]
  auto_redirect_to_identity  = true
  app_launcher_visible       = true
  http_only_cookie_attribute = true
  enable_binding_cookie      = false
  options_preflight_bypass   = false
  policies = [{
    id         = cloudflare_zero_trust_access_policy.owner.id
    precedence = 1
  }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "processor" {
  account_id                 = var.account_id
  name                       = "Embyfin processor"
  type                       = "self_hosted"
  domain                     = "${var.hostname}/machine/*"
  destinations               = [{ type = "public", uri = "${var.hostname}/machine/*" }]
  session_duration           = "24h"
  app_launcher_visible       = false
  auto_redirect_to_identity  = false
  enable_binding_cookie      = false
  http_only_cookie_attribute = false
  options_preflight_bypass   = false
  policies = [{
    id         = cloudflare_zero_trust_access_policy.processor.id
    precedence = 1
  }]

  lifecycle {
    prevent_destroy = true
  }
}

# Write this output to the repository root so Wrangler's relative asset/build
# paths retain their meaning. Runtime secrets stay in the deployed Worker/vault.
output "wrangler_config" {
  description = "Production Wrangler configuration populated with Terraform resource identifiers."
  value = merge(local.wrangler, {
    name       = var.worker_name
    account_id = var.account_id
    routes     = [{ pattern = var.hostname, custom_domain = true }]
    d1_databases = [merge(local.wrangler.d1_databases[0], {
      database_name = cloudflare_d1_database.catalog.name
      database_id   = cloudflare_d1_database.catalog.id
    })]
    r2_buckets = [
      { binding = "POSTERS", bucket_name = cloudflare_r2_bucket.derived["posters"].name },
      { binding = "BACKUPS", bucket_name = cloudflare_r2_bucket.derived["backups"].name },
    ]
    vars = merge(local.wrangler.vars, var.runtime_settings, {
      SOURCE_ENDPOINT = var.source_endpoint
      SOURCE_BUCKET   = var.source_bucket
      SOURCE_SCOPE    = var.source_scope
      APP_ORIGIN      = "https://${var.hostname}"
      ACCESS_ISSUER   = "https://${var.access_team_domain}"
      ACCESS_AUD      = cloudflare_zero_trust_access_application.browser.aud
      OWNER_EMAIL     = lower(var.owner_email)
      CF_ACCOUNT_ID   = var.account_id
      CF_DATABASE_ID  = cloudflare_d1_database.catalog.id
    })
  })
}
