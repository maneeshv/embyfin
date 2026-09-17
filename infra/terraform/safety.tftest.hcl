# Mocked resources only: this test does not contact or change Cloudflare.
mock_provider "cloudflare" {}

variables {
  account_id         = "00000000000000000000000000000000"
  hostname           = "media.test.example"
  owner_email        = "owner@example.com"
  viewer_emails      = ["viewer@example.com", "OWNER@example.com"]
  access_team_domain = "test-team.cloudflareaccess.com"
  login_method_id    = "00000000-0000-0000-0000-000000000001"
  adopt_existing     = false
  source_endpoint    = "https://00000000000000000000000000000000.r2.cloudflarestorage.com"
  source_bucket      = "test-originals"
}

run "private_installation" {
  command = plan

  assert {
    condition = (
      cloudflare_zero_trust_access_policy.owner.decision == "allow" &&
      [for r in cloudflare_zero_trust_access_policy.owner.include : r.email.email] == ["owner@example.com", "viewer@example.com"] &&
      cloudflare_zero_trust_access_application.browser.http_only_cookie_attribute &&
      one(cloudflare_zero_trust_access_application.browser.allowed_idps) == var.login_method_id
    )
    error_message = "Browser access must admit exactly the owner and listed viewers once, with the selected login provider and HTTPOnly cookie."
  }

  assert {
    condition = (
      cloudflare_zero_trust_access_policy.processor.decision == "bypass" &&
      one(cloudflare_zero_trust_access_application.processor.destinations).uri == "media.test.example/machine/*" &&
      one(cloudflare_zero_trust_access_application.browser.destinations).uri == "media.test.example"
    )
    error_message = "The Bypass policy must be attached only to the exact machine path."
  }

  assert {
    condition = (
      !cloudflare_r2_managed_domain.private["posters"].enabled &&
      !cloudflare_r2_managed_domain.private["backups"].enabled &&
      length(cloudflare_r2_bucket.derived) == 2
    )
    error_message = "Only the two derived buckets should be managed, with r2.dev access disabled."
  }

  assert {
    condition = (
      length(output.wrangler_config.d1_databases) == 1 &&
      output.wrangler_config.vars.ACCESS_ISSUER == "https://test-team.cloudflareaccess.com" &&
      output.wrangler_config.vars.OWNER_EMAIL == "owner@example.com" &&
      output.wrangler_config.vars.APP_ORIGIN == "https://media.test.example" &&
      output.wrangler_config.vars.SOURCE_BUCKET == "test-originals" &&
      output.wrangler_config.vars.PROCESSING_ENABLED == "false" &&
      !output.wrangler_config.workers_dev && !output.wrangler_config.preview_urls &&
      !contains(keys(output.wrangler_config.vars), "MACHINE_SECRET") &&
      !contains(keys(output.wrangler_config.vars), "CF_API_TOKEN") &&
      !contains(keys(output.wrangler_config.vars), "SOURCE_ACCESS_KEY_ID") &&
      !contains(keys(output.wrangler_config.vars), "SOURCE_SECRET_ACCESS_KEY")
    )
    error_message = "Generated config must use the selected owner/team/origin and keep runtime secrets and public preview URLs out."
  }
}

run "reject_adoption_without_ids" {
  command = plan
  variables {
    adopt_existing = true
  }
  expect_failures = [var.adopt_existing]
}
