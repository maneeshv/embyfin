ALTER TABLE libraries RENAME COLUMN kind TO legacy_kind;
ALTER TABLE libraries ADD COLUMN kind TEXT NOT NULL DEFAULT 'videos' CHECK(kind IN ('videos','movies','tv'));
UPDATE libraries SET kind=legacy_kind;
ALTER TABLE libraries DROP COLUMN legacy_kind;

CREATE TABLE tv_shows (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, search_name TEXT NOT NULL,
  first_air_date TEXT, overview TEXT, genres TEXT,
  poster_path TEXT, backdrop_path TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE tv_episodes (
  id INTEGER PRIMARY KEY, show_id INTEGER NOT NULL REFERENCES tv_shows(id),
  season_number INTEGER NOT NULL CHECK(season_number>=0), episode_number INTEGER NOT NULL CHECK(episode_number>0),
  name TEXT NOT NULL, search_name TEXT NOT NULL, overview TEXT, air_date TEXT,
  runtime INTEGER, still_path TEXT, updated_at INTEGER NOT NULL,
  UNIQUE(show_id,season_number,episode_number)
);
CREATE TABLE tv_cast (
  episode_id INTEGER NOT NULL REFERENCES tv_episodes(id), person_id INTEGER NOT NULL,
  name TEXT NOT NULL, character TEXT NOT NULL, profile_path TEXT,
  position INTEGER NOT NULL, PRIMARY KEY(episode_id,person_id)
);
CREATE INDEX tv_cast_person ON tv_cast(person_id,episode_id);
CREATE TABLE episode_matches (
  video_id TEXT PRIMARY KEY REFERENCES videos(id), revision TEXT NOT NULL,
  episode_id INTEGER REFERENCES tv_episodes(id),
  state TEXT NOT NULL CHECK(state IN ('matched','unmatched','ambiguous','failed','dismissed')),
  checked_at INTEGER NOT NULL,
  CHECK((state='matched')=(episode_id IS NOT NULL))
);
CREATE INDEX episode_matches_episode ON episode_matches(episode_id,revision);
CREATE TRIGGER episode_replacement AFTER UPDATE OF revision ON videos WHEN OLD.revision<>NEW.revision
BEGIN DELETE FROM episode_matches WHERE video_id=NEW.id; END;
CREATE TRIGGER episode_replaces_movie_insert AFTER INSERT ON episode_matches WHEN NEW.state='matched'
BEGIN DELETE FROM movie_matches WHERE video_id=NEW.video_id AND revision=NEW.revision; END;
CREATE TRIGGER episode_replaces_movie_update AFTER UPDATE ON episode_matches WHEN NEW.state='matched'
BEGIN DELETE FROM movie_matches WHERE video_id=NEW.video_id AND revision=NEW.revision; END;
CREATE TRIGGER movie_replaces_episode_insert AFTER INSERT ON movie_matches WHEN NEW.state='matched'
BEGIN DELETE FROM episode_matches WHERE video_id=NEW.video_id AND revision=NEW.revision; END;
CREATE TRIGGER movie_replaces_episode_update AFTER UPDATE ON movie_matches WHEN NEW.state='matched'
BEGIN DELETE FROM episode_matches WHERE video_id=NEW.video_id AND revision=NEW.revision; END;
