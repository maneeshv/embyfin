CREATE TABLE video_subtitles (
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id),
  revision TEXT NOT NULL, file_id INTEGER NOT NULL CHECK(file_id>0),
  language TEXT NOT NULL, release TEXT NOT NULL, vtt TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(video_id,revision,file_id)
);
CREATE INDEX subtitle_video ON video_subtitles(video_id,revision,created_at);
CREATE TRIGGER subtitle_replacement AFTER UPDATE OF revision ON videos WHEN OLD.revision<>NEW.revision
BEGIN DELETE FROM video_subtitles WHERE video_id=NEW.id AND revision<>NEW.revision; END;
