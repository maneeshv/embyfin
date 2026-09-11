# Import blocks are safe to retain after adoption. They do not copy D1 data.
import {
  for_each = var.adopt_existing ? toset(["catalog"]) : toset([])
  to       = cloudflare_d1_database.catalog
  id       = "${var.account_id}/45db29f5-b8cb-40a0-9263-12e0a6319d6a"
}

import {
  for_each = var.adopt_existing ? local.buckets : {}
  to       = cloudflare_r2_bucket.derived[each.key]
  id       = "${var.account_id}/${each.value}/default"
}

import {
  for_each = var.adopt_existing ? toset(["owner"]) : toset([])
  to       = cloudflare_zero_trust_access_policy.owner
  id       = "${var.account_id}/c09c9d9a-a9b6-4de0-8142-1c2544729975"
}

import {
  for_each = var.adopt_existing ? toset(["processor"]) : toset([])
  to       = cloudflare_zero_trust_access_policy.processor
  id       = "${var.account_id}/a30174a4-46de-4661-8ac1-37dbb8ce5f65"
}

import {
  for_each = var.adopt_existing ? toset(["browser"]) : toset([])
  to       = cloudflare_zero_trust_access_application.browser
  id       = "accounts/${var.account_id}/553b565e-41c6-4350-8fd5-fcb68d6354a6"
}

import {
  for_each = var.adopt_existing ? toset(["processor"]) : toset([])
  to       = cloudflare_zero_trust_access_application.processor
  id       = "accounts/${var.account_id}/70cba25e-bad9-4997-b90b-990f33e9d26c"
}
