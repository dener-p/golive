// golive server: Discord OAuth for host identity (M8 / roadmap last item).
//
// Flow: host page -> /auth/discord/login -> Discord authorize -> callback -> the server
// exchanges the code, loads /users/@me, issues an HttpOnly session cookie, then either
//   - lets the owner's session control the room, or
//   - binds ("claims") the room to this Discord account when the printed key was carried
//     through the round trip (that key is the physical-access proof that replaces it).
//
// Prints the key separately: without -discord-id/-discord-secret the whole /auth tree is
// disabled and the v1 printed-key gate is unchanged.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const sessionTTL = 12 * time.Hour

// oauthCfg is set by main(); enabled only when both Discord flags are present.
var oauthCfg *oauthConfig

type oauthConfig struct {
	clientID     string
	clientSecret string
	publicURL    string
	redirectURI  string
	enabled      bool
}

func newOAuthConfig(clientID, clientSecret, publicURL string) *oauthConfig {
	c := &oauthConfig{
		clientID:     clientID,
		clientSecret: clientSecret,
		publicURL:    strings.TrimRight(publicURL, "/"),
	}
	if c.clientID != "" && c.clientSecret != "" && c.publicURL != "" {
		c.redirectURI = c.publicURL + "/auth/discord/callback"
		c.enabled = true
	}
	return c
}

type discordUser struct {
	ID         string `json:"id"`
	Username   string `json:"username"`
	GlobalName string `json:"global_name"`
	Avatar     string `json:"avatar"`
}

func (u discordUser) displayName() string {
	if u.GlobalName != "" && u.GlobalName != u.Username {
		return u.GlobalName
	}
	return u.Username
}

// ---- one-time state (CSRF + key carried through the redirect) ----

type pendingAuth struct {
	room    string
	key     string // optional printed key; required to claim an unclaimed room
	expires time.Time
}

var (
	pendMu  sync.Mutex
	pending = map[string]pendingAuth{}
)

func newState(room, key string) (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	st := hex.EncodeToString(b)
	pendMu.Lock()
	pending[st] = pendingAuth{room: room, key: key, expires: time.Now().Add(10 * time.Minute)}
	pendMu.Unlock()
	return st, nil
}

// takeState consumes the nonce (single use, 10 min).
func takeState(st string) (pendingAuth, bool) {
	pendMu.Lock()
	defer pendMu.Unlock()
	p, ok := pending[st]
	delete(pending, st)
	if !ok || time.Now().After(p.expires) {
		return pendingAuth{}, false
	}
	return p, true
}

// ---- handlers ----

func availability(route http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if oauthCfg == nil || !oauthCfg.enabled {
			http.Error(w, "Discord auth is not configured (start the server with -discord-id and -discord-secret)", 404)
			return
		}
		route(w, r)
	}
}

// GET /auth/config — the host page asks whether/where to point the login button.
func handleAuthConfig(w http.ResponseWriter, _ *http.Request) {
	if oauthCfg == nil || !oauthCfg.enabled {
		json.NewEncoder(w).Encode(map[string]any{"enabled": false})
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"enabled": true, "publicUrl": oauthCfg.publicURL})
}

// GET /auth/me?room=<id> — current session identity + room ownership state.
func handleAuthMe(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"authenticated": false}
	room := r.URL.Query().Get("room")
	if room != "" {
		out["claimed"] = db.owner(room) != ""
	}
	if u := sessionUser(r); u != nil {
		out["authenticated"] = true
		out["id"] = u.ID
		out["name"] = u.displayName()
		out["avatar"] = u.Avatar
		if room != "" {
			out["owner"] = db.owner(room) == u.ID
		}
	}
	json.NewEncoder(w).Encode(out)
}

// GET /auth/discord/login?room=<id>&key=<printed key, optional> — kick off the 3-legged flow.
func handleDiscordLogin(w http.ResponseWriter, r *http.Request) {
	room, key := r.URL.Query().Get("room"), r.URL.Query().Get("key")
	if room == "" {
		http.Error(w, "missing room", 400)
		return
	}
	st, err := newState(room, key)
	if err != nil {
		http.Error(w, "state generation failed", 500)
		return
	}
	u := url.URL{
		Scheme: "https",
		Host:   "discord.com",
		Path:   "/api/oauth2/authorize",
		RawQuery: url.Values{
			"client_id":     {oauthCfg.clientID},
			"redirect_uri":  {oauthCfg.redirectURI},
			"response_type": {"code"},
			"scope":         {"identify"},
			"state":         {st},
		}.Encode(),
	}
	http.Redirect(w, r, u.String(), http.StatusFound)
}

// GET /auth/discord/callback?code=&state=
func handleDiscordCallback(w http.ResponseWriter, r *http.Request) {
	code, st := r.URL.Query().Get("code"), r.URL.Query().Get("state")
	pa, ok := takeState(st)
	if !ok {
		http.Error(w, "bad or expired state", 400)
		return
	}
	u, err := fetchDiscordUser(code, oauthCfg)
	if err != nil {
		log.Printf("discord login failed: %v", err)
		http.Error(w, "discord login failed", 502)
		return
	}
	tok, err := newSession(u)
	if err != nil {
		log.Printf("session issue failed: %v", err)
		http.Error(w, "session issue failed", 500)
		return
	}

	hostPage := oauthCfg.publicURL + "/host/" + pa.room
	owner := db.owner(pa.room)
	if owner != "" {
		if owner != u.ID { // someone else owns this room: signed in, but denied
			http.Redirect(w, r, hostPage+"?denied=1", http.StatusFound)
			return
		}
	} else if !claimRoom(pa, u) {
		http.Redirect(w, r, hostPage+"?unclaimed=1", http.StatusFound)
		return
	}

	if err := db.refreshOwnerIdentity(u); err != nil {
		log.Printf("refresh owner identity failed for %s: %v", u.ID, err)
	}

	setSessionCookie(w, tok)
	http.Redirect(w, r, hostPage, http.StatusFound)
}

// claimRoom binds the room once, only when the printed key matches (physical-access
// proof). Returns false when the key is missing/wrong, leaving the room unclaimed.
func claimRoom(pa pendingAuth, u discordUser) bool {
	if pa.key == "" {
		return false
	}
	ok, err := db.claim(pa.room, pa.key, u)
	if err != nil {
		log.Printf("[%s] claim failed: %v", pa.room, err)
		return false
	}
	if ok {
		log.Printf("[%s] room claimed by discord user %s", pa.room, u.ID)
	}
	return ok
}

// ---- session lifecycle ----

func setSessionCookie(w http.ResponseWriter, tok string) {
	secure := strings.HasPrefix(oauthCfg.publicURL, "https://")
	http.SetCookie(w, &http.Cookie{
		Name:     "golive_session",
		Value:    tok,
		Path:     "/",
		MaxAge:   int(sessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func sessionUser(r *http.Request) *discordUser {
	if oauthCfg == nil || !oauthCfg.enabled {
		return nil
	}
	c, err := r.Cookie("golive_session")
	if err != nil {
		return nil
	}
	return db.session(c.Value)
}

// fetchDiscordUser exchanges the code and returns the Discord profile.
func fetchDiscordUser(code string, cfg *oauthConfig) (discordUser, error) {
	var u discordUser
	resp, err := http.PostForm("https://discord.com/api/oauth2/token", url.Values{
		"client_id":     {cfg.clientID},
		"client_secret": {cfg.clientSecret},
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {cfg.redirectURI},
	})
	if err != nil {
		return u, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return u, fmt.Errorf("token status %d: %s", resp.StatusCode, b)
	}
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil {
		return u, err
	}
	req, _ := http.NewRequest(http.MethodGet, "https://discord.com/api/v10/users/@me", nil)
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	mresp, err := http.DefaultClient.Do(req)
	if err != nil {
		return u, err
	}
	defer mresp.Body.Close()
	if mresp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(mresp.Body, 512))
		return u, fmt.Errorf("users/@me status %d: %s", mresp.StatusCode, b)
	}
	if err := json.NewDecoder(mresp.Body).Decode(&u); err != nil {
		return u, err
	}
	return u, nil
}

func newSession(u discordUser) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(b)
	if err := db.upsertSession(tok, u.ID, u.displayName(), u.Avatar, time.Now().Add(sessionTTL)); err != nil {
		return "", err
	}
	return tok, nil
}
