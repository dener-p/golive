package main

// Public distribution surface: a landing page, and release metadata/download endpoints that
// packaging/build-bundle.ps1 feeds by dropping latest.json + the installer into
// server/public/helper/.

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

//go:embed landing.html
var landingHTML []byte

// landingHandler serves the public "what is golive / download the host app" page.
func landingHandler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(landingHTML)
}

// helperStaticDir locates the folder where release artifacts are published
// (server/public/helper next to the executable, then relative to the working dir).
func helperStaticDir() string {
	for _, c := range []string{
		filepath.Join(filepath.Dir(os.Args[0]), "server", "public", "helper"),
		"server/public/helper",
		"public/helper",
	} {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	return ""
}

// helperMeta reads latest.json (written by the packaging script) as
// {"version","file","sha256"} plus "available".
func helperMeta() map[string]any {
	dir := helperStaticDir()
	if dir == "" {
		return map[string]any{"available": false}
	}
	b, err := os.ReadFile(filepath.Join(dir, "latest.json"))
	if err != nil {
		return map[string]any{"available": false}
	}
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF}) // tolerate UTF-8 BOM (Windows PowerShell Set-Content)
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return map[string]any{"available": false}
	}
	m["available"] = true
	return m
}

// GET /api/helper/latest — version metadata for the landing page.
func handleHelperLatest(w http.ResponseWriter, _ *http.Request) {
	json.NewEncoder(w).Encode(helperMeta())
}

// GET /api/helper/download — redirect to the current installer artifact.
func handleHelperDownload(w http.ResponseWriter, r *http.Request) {
	f, _ := helperMeta()["file"].(string)
	if f == "" || helperStaticDir() == "" {
		http.Error(w, "no published helper build yet — run packaging/build-bundle.ps1", 404)
		return
	}
	http.Redirect(w, r, "/helper/"+f, http.StatusFound)
}

// register helper static files (safe: only when the dir exists).
func registerHelperStatic(mux *http.ServeMux) {
	dir := helperStaticDir()
	if dir == "" {
		return
	}
	log.Printf("serving helper downloads from %s", dir)
	fs := http.StripPrefix("/helper/", http.FileServer(http.Dir(dir)))
	// Artifacts are large; every build is published under a new content-addressed name.
	// Never let any layer cache a /helper/ response — a stale same-name copy was served
	// to real downloads for hours after a rebuild (Cloudflare default static TTL).
	mux.Handle("/helper/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		fs.ServeHTTP(w, r)
	}))
}
