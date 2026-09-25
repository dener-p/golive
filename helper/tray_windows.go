//go:build windows

package main

// System tray for the helper (Windows). systray must run its message loop on the main
// goroutine; serveTray does that and boots the signaling/streaming loop in the background.

import (
	"bytes"
	_ "embed" // go:embed directive support
	"image"
	_ "image/png" // register the PNG decoder for image.DecodeConfig below
	"os/exec"
	"strings"

	"github.com/getlantern/systray"
)

// serveTray blocks until the user quits. inBackground boots the real helper (WS loop,
// streams) and keeps running until the process exits.
func serveTray(h *helper, inBackground func()) {
	systray.Run(func() {
		setupTrayMenu(h)
		go inBackground()
	}, func() {
		h.stop()
	})
}

func setupTrayMenu(h *helper) {
	base := strings.NewReplacer("ws://", "http://", "wss://", "https://").Replace(h.server)
	hostURL := base + "/host/" + h.room + "?key=" + h.key
	viewerURL := base + "/watch/" + h.room

	systray.SetTitle("golive")
	systray.SetTooltip("golive — room " + h.room)
	systray.SetIcon(goliveIcon())

	mOpen := systray.AddMenuItem("Open host page", "Open the host control page in your browser")
	mCopy := systray.AddMenuItem("Copy viewer link", "Copy your watch link to the clipboard")
	systray.AddSeparator()
	mCode := systray.AddMenuItem("Pairing code: …", "Enter it on the host page to bind this room to your Discord account")
	mCode.Disable()
	mNew := systray.AddMenuItem("New pairing code", "Refresh the code now (it expires after 5 minutes)")
	systray.AddSeparator()
	mStart := systray.AddMenuItem("Start streaming", "Screen → AV1 → your viewers")
	mStop := systray.AddMenuItem("Stop streaming", "End the live stream")
	mStop.Disable()
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Exit golive helper")

	onPairCode = func(code string) {
		if code == "" {
			mCode.SetTitle("Pairing code: unavailable")
			mCode.SetTooltip("No server or no code yet")
		} else {
			mCode.SetTitle("Pairing code: " + code)
			mCode.SetTooltip("Enter " + code + " on " + base + "/host to bind this room")
		}
	}
	if c := h.currentCode(); c != "" {
		onPairCode(c)
	}

	go func() {
		for {
			select {
			case <-mOpen.ClickedCh:
				openURL(hostURL)
			case <-mCopy.ClickedCh:
				copyText(viewerURL)
			case <-mNew.ClickedCh:
				h.refreshPair()
			case <-mStart.ClickedCh:
				mStart.Disable()
				mStop.Enable()
				go h.start(h.defaults)
			case <-mStop.ClickedCh:
				mStop.Disable()
				mStart.Enable()
				go h.stop()
			case <-mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}

func openURL(url string) {
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func copyText(s string) {
	cmd := exec.Command("powershell", "-NoProfile", "-Command", "Set-Clipboard", "-Value", s)
	noWindow(cmd) // powershell is console-subsystem: without this it pops a console flash
	cmd.Run()
}

// The tray icon is the site favicon (keep helper/assets/favicon.png in sync with
// server/public/favicon.png — same art, so the tray matches the browser tabs).
//
//go:embed assets/favicon.png
var faviconPNG []byte

// goliveIcon wraps the favicon PNG as a Vista+ PNG-compressed ICO for the tray.
func goliveIcon() []byte {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(faviconPNG))
	if err != nil {
		return nil // icons are cosmetic; a nil icon just means the default is shown
	}
	blob := faviconPNG
	ico := new(bytes.Buffer)
	ico.Write([]byte{0, 0, 1, 0, 1, 0})                            // ICONDIR: reserved, type=1, count=1
	ico.WriteByte(byte(cfg.Width))                                 // width
	ico.WriteByte(byte(cfg.Height))                                // height
	ico.Write([]byte{0, 0})                                        // color count, reserved
	ico.Write([]byte{1, 0, 32, 0})                                 // planes=1, bitCount=32
	ico.Write([]byte{byte(len(blob)), byte(len(blob) >> 8), 0, 0}) // bytesInRes (LE u32)
	ico.Write([]byte{22, 0, 0, 0})                                 // imageOffset = 6 + 16
	ico.Write(blob)
	return ico.Bytes()
}
