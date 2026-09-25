// golive server: SQLite persistence for Discord-auth rooms and host sessions.
//
// The live room state (helper/hosts/viewers, WebRTC relay) stays in memory; the DB
// only keeps the two durable bits of Discord auth:
//   - rooms:    room id -> printed host key (written at each helper handshake) and,
//               once claimed, the owning Discord user id
//   - sessions: login token -> Discord user, so a signed-in host survives server restarts
//
// The driver is modernc.org/sqlite (pure Go, no CGO) so the server cross-compiles to
// Linux for the notebook. The schema is plain SQLite, so pointing these same queries at
// a Turso/libSQL database later is mostly a driver swap.
package main

import (
	"database/sql"
	"path/filepath"
	"strings"
	"time"

	tursodb "github.com/tursodatabase/libsql-client-go/libsql"
	_ "modernc.org/sqlite"
)

type store struct {
	db *sql.DB
}

// openStore picks the backend: a Turso/libSQL URL (with token) when given, otherwise a
// local SQLite file. Either way every query below is plain SQLite, so remote/local
// behaviour and the schema are identical.
func openStore(path, tursoURL, tursoToken string) (*store, error) {
	if tursoURL != "" {
		return openTurso(tursoURL, tursoToken)
	}
	return openLocal(path)
}

func openLocal(path string) (*store, error) {
	// DSN: file: + toSlash so Windows backslashes don't confuse the URI parser.
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer; modernc sqlite holds a single connection well
	s := &store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// openTurso connects to a Turso/libSQL database over its HTTP(S) wire protocol
// (libsql-client-go, pure Go). The token goes through WithAuthToken, never the URL.
func openTurso(rawURL, token string) (*store, error) {
	if !strings.Contains(rawURL, "://") {
		rawURL = "https://" + rawURL
	}
	conn, err := tursodb.NewConnector(rawURL, tursodb.WithAuthToken(token))
	if err != nil {
		return nil, err
	}
	s := &store{db: sql.OpenDB(conn)}
	s.db.SetMaxOpenConns(4) // remote: more heads beat the round-trip latency
	if err := s.migrate(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *store) close() { s.db.Close() }

func (s *store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  host_key   TEXT NOT NULL DEFAULT '',
  owner      TEXT NOT NULL DEFAULT '',
  claimed_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  username   TEXT NOT NULL DEFAULT '',
  avatar     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP,
  expires_at TIMESTAMP
);
`)
	return err
}

// saveHostKey upserts the room row on every helper handshake, so the printed key is
// known to the DB even between helper/server restarts (claim + owner control rely on it).
func (s *store) saveHostKey(id, key string) error {
	_, err := s.db.Exec(
		"INSERT INTO rooms (id, host_key) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET host_key = excluded.host_key",
		id, key)
	return err
}

func (s *store) hostKey(id string) string {
	var k string
	s.db.QueryRow("SELECT host_key FROM rooms WHERE id = ?", id).Scan(&k)
	return k
}

func (s *store) owner(id string) string {
	var o string
	s.db.QueryRow("SELECT owner FROM rooms WHERE id = ?", id).Scan(&o)
	return o
}

// claim binds a Discord user as the room owner, but only when the caller still proves
// the printed key (physical access). Returns false when the key doesn't match.
func (s *store) claim(id, key, discordID string) (bool, error) {
	res, err := s.db.Exec(
		"UPDATE rooms SET owner = ?, claimed_at = ? WHERE id = ? AND host_key = ?",
		discordID, time.Now().UTC(), id, key)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *store) upsertSession(token, discordID, username, avatar string, expires time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO sessions (token, discord_id, username, avatar, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(token) DO UPDATE SET discord_id = excluded.discord_id, username = excluded.username,
		   avatar = excluded.avatar, expires_at = excluded.expires_at`,
		token, discordID, username, avatar, time.Now().UTC(), expires.UTC())
	return err
}

func (s *store) session(token string) *discordUser {
	var u discordUser
	var expires time.Time
	err := s.db.QueryRow(
		"SELECT discord_id, username, avatar, expires_at FROM sessions WHERE token = ? AND expires_at > ?",
		token, time.Now().UTC()).Scan(&u.ID, &u.Username, &u.Avatar, &expires)
	if err != nil {
		// expired rows are garbage-collected opportunistically
		s.db.Exec("DELETE FROM sessions WHERE expires_at <= ?", time.Now().UTC())
		return nil
	}
	if expires.IsZero() { // NULL safety
		return nil
	}
	return &u
}

func (s *store) deleteSession(token string) error {
	_, err := s.db.Exec("DELETE FROM sessions WHERE token = ?", token)
	return err
}