SELECT key AS record_type,value FROM json_each(json_object(
  'schema',(SELECT version FROM schema_info),
  'videos',(SELECT count(*) FROM videos),
  'users',(SELECT count(*) FROM users),
  'libraries',(SELECT count(*) FROM libraries),
  'favorites',(SELECT count(*) FROM user_video WHERE favorite=1),
  'progress_records',(SELECT count(*) FROM user_video WHERE position>0),
  'enabled_viewers_must_be_zero',(SELECT count(*) FROM users WHERE role='viewer' AND enabled=1),
  'restored_grants_must_be_zero',(SELECT count(*) FROM grants),
  'playback_leases_must_be_zero',(SELECT count(*) FROM user_video WHERE generation IS NOT NULL),
  'active_runs_must_be_zero',(SELECT count(*) FROM processor_runs WHERE status='active'),
  'leased_jobs_must_be_zero',(SELECT count(*) FROM jobs WHERE state='leased')
));
