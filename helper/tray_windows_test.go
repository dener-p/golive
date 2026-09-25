//go:build windows

package main

import (
	"bytes"
	"image"
	_ "image/png"
	"testing"
)

func TestGoliveIconWrapsFaviconICO(t *testing.T) {
	ico := goliveIcon()
	if ico == nil {
		t.Fatal("goliveIcon returned nil")
	}
	if len(ico) < 22+8 {
		t.Fatalf("ico too short: %d bytes", len(ico))
	}
	// ICONDIR: reserved(0,0) type(1) count(1)
	if !bytes.Equal(ico[:6], []byte{0, 0, 1, 0, 1, 0}) {
		t.Fatal("bad ICONDIR header")
	}
	// entry: width/height must match the embedded favicon
	cfg, _, err := image.DecodeConfig(bytes.NewReader(faviconPNG))
	if err != nil {
		t.Fatal(err)
	}
	if int(ico[6]) != cfg.Width || int(ico[7]) != cfg.Height {
		t.Fatalf("icon entry dims %dx%d != favicon %dx%d", ico[6], ico[7], cfg.Width, cfg.Height)
	}
	// imageOffset == 22 (6 header + 16 entry), payload starts with PNG magic
	if !bytes.Equal(ico[18:22], []byte{22, 0, 0, 0}) {
		t.Fatal("bad image offset")
	}
	if !bytes.Equal(ico[22:26], []byte{0x89, 'P', 'N', 'G'}) {
		t.Fatal("payload at offset 22 is not a PNG")
	}
}
