//go:build windows

package main

// System tray for the helper (Windows). systray must run its message loop on the main
// goroutine; serveTray does that and boots the signaling/streaming loop in the background.

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
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
			mCode.SetTooltip("Enter " + code + " on golive.puhl.dev/host to bind this room")
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
	exec.Command("powershell", "-NoProfile", "-Command", "Set-Clipboard", "-Value", s).Run()
}

// goliveIcon renders a 32x32 tray icon (green rounded square with a white play triangle)
// at runtime — no binary asset to ship — and wraps it as a Vista+ PNG-compressed ICO.
func goliveIcon() []byte {
	const S = 32
	img := image.NewRGBA(image.Rect(0, 0, S, S))
	green := color.RGBA{0x2f, 0x9e, 0x44, 0xff}
	white := color.RGBA{0xff, 0xff, 0xff, 0xff}

	// rounded square body
	r := 6
	for y := 0; y < S; y++ {
		for x := 0; x < S; x++ {
			dx, dy := 0, 0
			switch {
			case x < r && y < r:
				dx, dy = r-x, r-y
			case x >= S-r && y < r:
				dx, dy = x-(S-r-1), r-y
			case x < r && y >= S-r:
				dx, dy = r-x, y-(S-r-1)
			case x >= S-r && y >= S-r:
				dx, dy = x-(S-r-1), y-(S-r-1)
			}
			if dx*dx+dy*dy <= r*r || (dx == 0 && dy == 0) {
				img.Set(x, y, green)
			}
		}
	}

	// white play triangle: points (12,9) (12,23) (24,16)
	for y := 9; y <= 23; y++ {
		w := (y - 9) * 15 / 28 // half-width grows from 0 at y=9 to 12 at y=23 (x 12..24)
		for x := 12; x <= 12+w; x++ {
			img.Set(x, y, white)
		}
	}

	var pngBuf bytes.Buffer
	png.Encode(&pngBuf, img)
	blob := pngBuf.Bytes()

	ico := new(bytes.Buffer)
	ico.Write([]byte{0, 0, 1, 0, 1, 0})                            // ICONDIR: reserved, type=1, count=1
	ico.WriteByte(S)                                               // width
	ico.WriteByte(S)                                               // height
	ico.Write([]byte{0, 0})                                        // color count, reserved
	ico.Write([]byte{1, 0, 32, 0})                                 // planes=1, bitCount=32
	ico.Write([]byte{byte(len(blob)), byte(len(blob) >> 8), 0, 0}) // bytesInRes (LE u32)
	ico.Write([]byte{22, 0, 0, 0})                                 // imageOffset = 6 + 16
	ico.Write(blob)
	return ico.Bytes()
}
