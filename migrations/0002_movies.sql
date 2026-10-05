ALTER TABLE libraries ADD COLUMN kind TEXT NOT NULL DEFAULT 'videos' CHECK(kind IN ('videos','movies'));

CREATE TABLE movies (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, search_title TEXT NOT NULL,
  release_date TEXT, overview TEXT, tagline TEXT, runtime INTEGER,
  genres TEXT, poster_path TEXT, backdrop_path TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE movie_cast (
  movie_id INTEGER NOT NULL REFERENCES movies(id), person_id INTEGER NOT NULL,
  name TEXT NOT NULL, character TEXT NOT NULL, profile_path TEXT,
  position INTEGER NOT NULL, PRIMARY KEY(movie_id,person_id)
);
CREATE INDEX movie_cast_person ON movie_cast(person_id,movie_id);
CREATE TABLE movie_matches (
  video_id TEXT PRIMARY KEY REFERENCES videos(id), revision TEXT NOT NULL,
  movie_id INTEGER REFERENCES movies(id),
  state TEXT NOT NULL CHECK(state IN ('matched','unmatched','ambiguous','failed','dismissed')),
  checked_at INTEGER NOT NULL,
  CHECK((state='matched')=(movie_id IS NOT NULL))
);
CREATE TRIGGER movie_replacement AFTER UPDATE OF revision ON videos WHEN OLD.revision<>NEW.revision
BEGIN DELETE FROM movie_matches WHERE video_id=NEW.id; END;
