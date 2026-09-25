package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// handleHelperDownload must serve a proper 302. It previously panicked by passing a nil
// *http.Request to http.Redirect — every click on the landing page's Download button killed
// the connection (surfaced as 502 Bad Gateway behind the tunnel).
func TestHandleHelperDownloadRedirects(t *testing.T) {
	dir := t.TempDir()
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(old)
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(dir, "public", "helper"), 0o755)
	if err := os.WriteFile(filepath.Join(dir, "public", "helper", "latest.json"),
		[]byte(`{"version":"0.9.0","file":"golive-test.zip"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/helper/download", handleHelperDownload)
	req := httptest.NewRequest("GET", "/api/helper/download", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/helper/golive-test.zip" {
		t.Fatalf("Location = %q", loc)
	}
}
