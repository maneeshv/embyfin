PRAGMA foreign_keys = ON;
CREATE TABLE sources (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider = 'r2'),
  bucket TEXT NOT NULL, scope TEXT NOT NULL, UNIQUE(provider,bucket)
);
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  subject TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('owner','viewer')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_owner ON users(role) WHERE role='owner';
CREATE TABLE libraries (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
  name TEXT NOT NULL, prefix TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  frozen INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0,
  next_scan INTEGER NOT NULL DEFAULT 0, last_success INTEGER, created_at INTEGER NOT NULL
);
CREATE TRIGGER library_no_overlap BEFORE INSERT ON libraries
WHEN EXISTS(SELECT 1 FROM libraries WHERE source_id=NEW.source_id AND
  (substr(prefix,1,length(NEW.prefix))=NEW.prefix OR substr(NEW.prefix,1,length(prefix))=prefix))
BEGIN SELECT RAISE(ABORT,'overlapping library prefix'); END;
CREATE TRIGGER library_immutable BEFORE UPDATE OF source_id,prefix ON libraries
WHEN OLD.frozen=1 AND (NEW.source_id<>OLD.source_id OR NEW.prefix<>OLD.prefix)
BEGIN SELECT RAISE(ABORT,'library scope is frozen'); END;
CREATE TRIGGER library_edit_no_overlap BEFORE UPDATE OF source_id,prefix ON libraries
WHEN EXISTS(SELECT 1 FROM libraries WHERE id<>NEW.id AND source_id=NEW.source_id AND
  (substr(prefix,1,length(NEW.prefix))=NEW.prefix OR substr(NEW.prefix,1,length(prefix))=prefix))
BEGIN SELECT RAISE(ABORT,'overlapping library prefix'); END;
CREATE TABLE grants (
  user_id TEXT NOT NULL REFERENCES users(id), library_id TEXT NOT NULL REFERENCES libraries(id),
  PRIMARY KEY(user_id,library_id)
);
CREATE TABLE scans (
  id TEXT PRIMARY KEY, library_id TEXT NOT NULL REFERENCES libraries(id),
  status TEXT NOT NULL CHECK(status IN ('listing','reconciling','paused','complete','failed','cancelled')),
  resume_status TEXT, cursor TEXT, lease_token TEXT, lease_until INTEGER,
  discovered INTEGER NOT NULL DEFAULT 0, ignored INTEGER NOT NULL DEFAULT 0,
  cursor_restarts INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  completed_at INTEGER, error TEXT
);
CREATE UNIQUE INDEX active_scan ON scans(library_id) WHERE status IN ('listing','reconciling','paused');
CREATE TABLE videos (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
  library_id TEXT NOT NULL REFERENCES libraries(id), object_key TEXT NOT NULL,
  filename TEXT NOT NULL, parent TEXT NOT NULL, search_name TEXT NOT NULL, search_path TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes>=0), modified TEXT NOT NULL, etag TEXT NOT NULL, revision TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, seen_scan TEXT,
  available INTEGER NOT NULL DEFAULT 1, refresh_requested INTEGER NOT NULL DEFAULT 0,
  enrichment TEXT NOT NULL DEFAULT 'pending' CHECK(enrichment IN ('pending','ready','failed')),
  duration REAL, width INTEGER, height INTEGER, container TEXT, video_codec TEXT, audio_codec TEXT,
  poster_key TEXT, processing_error TEXT, UNIQUE(source_id,object_key)
);
CREATE INDEX video_folder ON videos(library_id,parent,filename,id);
CREATE INDEX video_added ON videos(library_id,first_seen DESC,id);
CREATE INDEX video_seen ON videos(library_id,seen_scan);
CREATE TABLE user_video (
  user_id TEXT NOT NULL REFERENCES users(id), video_id TEXT NOT NULL REFERENCES videos(id),
  favorite INTEGER NOT NULL DEFAULT 0, watched INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0 CHECK(position>=0), last_watched INTEGER,
  revision TEXT NOT NULL, generation TEXT, sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,video_id)
);
CREATE INDEX user_activity ON user_video(user_id,last_watched DESC);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id), revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','leased','ready','failed','stale')),
  token TEXT, run_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0, error TEXT, poster_key TEXT,
  read_bytes INTEGER NOT NULL DEFAULT 0, read_requests INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0, peak_scratch INTEGER NOT NULL DEFAULT 0,
  cpu_ms INTEGER NOT NULL DEFAULT 0, peak_rss INTEGER NOT NULL DEFAULT 0,
  UNIQUE(video_id,revision,version)
);
CREATE INDEX claim_jobs ON jobs(state,retry_after,lease_until);
CREATE TABLE processor_runs (
  slot INTEGER PRIMARY KEY CHECK(slot=1), token TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','stopped')),
  started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, lease_until INTEGER NOT NULL,
  heartbeat INTEGER NOT NULL, read_limit INTEGER NOT NULL, job_seconds INTEGER NOT NULL,
  read_bytes INTEGER NOT NULL DEFAULT 0, next_dispatch INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TRIGGER replacement AFTER UPDATE OF revision ON videos WHEN OLD.revision<>NEW.revision
BEGIN
  UPDATE user_video SET watched=0,position=0,last_watched=NULL,revision=NEW.revision,generation=NULL,sequence=0 WHERE video_id=NEW.id;
  UPDATE videos SET enrichment='pending',duration=NULL,width=NULL,height=NULL,container=NULL,
    video_codec=NULL,audio_codec=NULL,poster_key=NULL,processing_error=NULL WHERE id=NEW.id;
  UPDATE jobs SET state='stale',token=NULL,lease_until=NULL WHERE video_id=NEW.id AND revision<>NEW.revision;
END;
CREATE TABLE schema_info(version INTEGER PRIMARY KEY CHECK(version=1));
INSERT INTO schema_info VALUES(1);
