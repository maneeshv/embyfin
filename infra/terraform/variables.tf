variable "account_id" {
  type        = string
  description = "Cloudflare account that owns Embyfin infrastructure."
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "Use the 32-character Cloudflare account ID."
  }
}

variable "hostname" {
  type        = string
  description = "Private application's exact hostname, without scheme, path or wildcard."
  validation {
    condition     = can(regex("^[a-z0-9]+([.-][a-z0-9]+)+$", var.hostname))
    error_message = "Use a lowercase DNS hostname without a wildcard, scheme or path."
  }
}

variable "database_name" {
  type        = string
  default     = "embyfin"
  description = "Catalog database name; set to the restored database's actual name during recovery adoption."
}

variable "owner_email" {
  type        = string
  description = "Owner admitted by Access and used for empty-database bootstrap."
  validation {
    condition     = can(regex("^[^ @]+@[^ @]+\\.[^ @]+$", var.owner_email))
    error_message = "Use the owner's complete email address."
  }
}

variable "access_team_domain" {
  type        = string
  description = "Existing Zero Trust team domain, without https://."
  validation {
    condition     = can(regex("^[a-z0-9-]+\\.cloudflareaccess\\.com$", var.access_team_domain))
    error_message = "Use the actual team-name.cloudflareaccess.com domain."
  }
}

variable "login_method_id" {
  type        = string
  description = "Existing one-time PIN identity provider ID; Terraform does not own this shared provider."
  validation {
    condition     = can(regex("^[a-f0-9-]{32,36}$", var.login_method_id))
    error_message = "Supply the existing identity provider ID, not its display name."
  }
}

variable "adopt_existing" {
  type        = bool
  default     = true
  description = "Import the recorded production resources; false only for a new installation with separate state."
  validation {
    condition     = !var.adopt_existing || (var.account_id == "a58958f1af472b99313d58370ff74638" && var.hostname == "media.embyfin.uk")
    error_message = "Recorded imports belong to the existing Embyfin installation. For a new installation use separate state and adopt_existing=false."
  }
}
