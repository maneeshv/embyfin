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

variable "viewer_emails" {
  type        = list(string)
  default     = []
  nullable    = false
  description = "Additional people admitted by Access. Application accounts and library grants are still managed in Settings."
  validation {
    condition     = alltrue([for e in var.viewer_emails : can(regex("^[^ @]+@[^ @]+\\.[^ @]+$", e))])
    error_message = "Use complete email addresses for every viewer."
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
  default     = false
  description = "Adopt resources whose IDs are explicitly supplied in existing_resources."
  validation {
    condition = !var.adopt_existing || alltrue([
      for id in values(var.existing_resources) : can(regex("^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$", id))
    ])
    error_message = "Adoption requires all five existing resource UUIDs in private inputs."
  }
}

variable "existing_resources" {
  type = object({
    catalog          = optional(string, "")
    owner_policy     = optional(string, "")
    processor_policy = optional(string, "")
    browser_app      = optional(string, "")
    processor_app    = optional(string, "")
  })
  default  = {}
  nullable = false
}

variable "source_endpoint" {
  type        = string
  description = "Read-only source S3 endpoint; credentials are Worker secrets."
  validation {
    condition     = can(regex("^https://[a-f0-9]{32}\\.r2\\.cloudflarestorage\\.com$", var.source_endpoint))
    error_message = "Supply an HTTPS R2 account endpoint."
  }
}

variable "source_bucket" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.source_bucket))
    error_message = "Supply the existing source bucket name."
  }
}

variable "source_scope" {
  type    = string
  default = ""
}

variable "poster_bucket_name" {
  type    = string
  default = "embyfin-posters"
}

variable "backup_bucket_name" {
  type    = string
  default = "embyfin-backups"
}

variable "worker_name" {
  type    = string
  default = "embyfin"
}

variable "runtime_settings" {
  type        = map(string)
  default     = {}
  description = "Optional operational overrides; identity, bindings and secrets cannot be overridden here."
  validation {
    condition = alltrue([for key in keys(var.runtime_settings) : contains([
      "MAINTENANCE", "PROCESSING_ENABLED", "PROCESSING_SAMPLE", "BACKUP_HOUR_UTC",
      "JOB_READ_LIMIT", "JOB_SECONDS", "BATCH_SECONDS", "VIDEO_EXTENSIONS"
    ], key)])
    error_message = "Only documented operational settings are allowed; never put secrets here."
  }
}
