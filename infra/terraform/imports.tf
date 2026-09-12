# Optional imports use installation-specific inputs. They do not copy D1 data.
import {
  for_each = var.adopt_existing ? toset(["catalog"]) : toset([])
  to       = cloudflare_d1_database.catalog
  id       = "${var.account_id}/${var.existing_resources.catalog}"
}

import {
  for_each = var.adopt_existing ? local.buckets : {}
  to       = cloudflare_r2_bucket.derived[each.key]
  id       = "${var.account_id}/${each.value}/default"
}

import {
  for_each = var.adopt_existing ? toset(["owner"]) : toset([])
  to       = cloudflare_zero_trust_access_policy.owner
  id       = "${var.account_id}/${var.existing_resources.owner_policy}"
}

import {
  for_each = var.adopt_existing ? toset(["processor"]) : toset([])
  to       = cloudflare_zero_trust_access_policy.processor
  id       = "${var.account_id}/${var.existing_resources.processor_policy}"
}

import {
  for_each = var.adopt_existing ? toset(["browser"]) : toset([])
  to       = cloudflare_zero_trust_access_application.browser
  id       = "accounts/${var.account_id}/${var.existing_resources.browser_app}"
}

import {
  for_each = var.adopt_existing ? toset(["processor"]) : toset([])
  to       = cloudflare_zero_trust_access_application.processor
  id       = "accounts/${var.account_id}/${var.existing_resources.processor_app}"
}
