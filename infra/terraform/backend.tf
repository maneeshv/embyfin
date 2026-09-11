terraform {
  backend "s3" {
    bucket = "embyfin-terraform-state"
    key    = "production/terraform.tfstate"
    region = "auto"
    endpoints = {
      s3 = "https://a58958f1af472b99313d58370ff74638.r2.cloudflarestorage.com"
    }
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
