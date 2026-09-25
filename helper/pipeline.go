package main

// Capture + AV1 encode, done by a GStreamer child process (gst-launch-1.0).
//
// The pipeline ends in `tcpclientsink` connecting to a loopback listener that we own; we
// read the raw AV1 OBU stream from it and packetize it ourselves. Loopback TCP is used
// (rather than stdout) because it is binary-safe on Windows and needs no extra plugins.

import (
	"bytes"
	"fmt"
	"net"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type captureOpts struct {
	Source  string // "" = screen, "test" = test pattern, anything else = raw gst fragment
	Encoder string // auto | svt | nv | qsv | va | amf
	Bitrate int    // kbit/s
	FPS     int
	GOP     int // keyframe interval in frames
	Monitor int // Windows only
}

type capture struct {
	Encoder string
	cmd     *exec.Cmd
	conn    net.Conn
	done    chan struct{} // closed when the pipeline is gone
	once    sync.Once
	stopped atomic.Bool
}

func (c *capture) Stop() {
	c.stopped.Store(true)
	c.once.Do(func() {
		if c.conn != nil {
			c.conn.Close()
		}
		if c.cmd != nil && c.cmd.Process != nil {
			c.cmd.Process.Kill()
		}
	})
}

// name -> encoder element. Software first in the table is NOT the order tried; see candidates().
func encoderElement(name string, kbps, gop int) (element string, raw string) {
	switch name {
	case "nv":
		return fmt.Sprintf("nvav1enc bitrate=%d gop-size=%d", kbps, gop), "NV12"
	case "qsv":
		return fmt.Sprintf("qsvav1enc bitrate=%d gop-size=%d", kbps, gop), "NV12"
	case "va":
		return fmt.Sprintf("vaav1enc bitrate=%d key-int-max=%d", kbps, gop), "NV12"
	case "amf":
		return fmt.Sprintf("amfav1enc bitrate=%d gop-size=%d", kbps, gop), "NV12"
	default: // svt: software, low-delay, CBR-ish
		return fmt.Sprintf("svtav1enc preset=10 target-bitrate=%d intra-period-length=%d intra-refresh-type=2 "+
			"parameters-string=lookahead=0:pred-struct=1", kbps, gop), "I420"
	}
}

var gstElementFor = map[string]string{
	"nv": "nvav1enc", "qsv": "qsvav1enc", "va": "vaav1enc", "amf": "amfav1enc", "svt": "svtav1enc",
}

func haveElement(el string) bool {
	return exec.Command("gst-inspect-1.0", el).Run() == nil
}

// candidates: hardware encoders that exist on this machine (best first), then software.
func candidates(pref string) []string {
	if pref != "" && pref != "auto" {
		return []string{pref}
	}
	var out []string
	for _, n := range []string{"nv", "qsv", "amf", "va"} {
		if haveElement(gstElementFor[n]) {
			out = append(out, n)
		}
	}
	return append(out, "svt")
}

func sourceElement(o captureOpts) string {
	switch {
	case o.Source == "test":
		return "videotestsrc is-live=true pattern=ball"
	case o.Source != "":
		return o.Source
	}
	switch runtime.GOOS {
	case "windows":
		return fmt.Sprintf("d3d11screencapturesrc show-cursor=true monitor-index=%d", o.Monitor)
	case "darwin":
		return "avfvideosrc capture-screen=true capture-screen-cursor=true"
	default:
		return "ximagesrc use-damage=false show-pointer=true"
	}
}

func buildPipeline(o captureOpts, enc string, port int) string {
	el, raw := encoderElement(enc, o.Bitrate, o.GOP)
	return fmt.Sprintf("%s ! queue max-size-buffers=2 leaky=downstream ! videoconvert ! videorate ! "+
		"video/x-raw,format=%s,framerate=%d/1 ! %s ! av1parse ! "+
		"video/x-av1,stream-format=obu-stream,alignment=tu ! tcpclientsink host=127.0.0.1 port=%d",
		sourceElement(o), raw, o.FPS, el, port)
}

// startCapture tries each candidate encoder until one produces a frame. onUnit is called
// from a single goroutine for every encoded frame; onExit when the pipeline dies.
func startCapture(o captureOpts, onUnit func([]obu), onExit func(error)) (*capture, error) {
	if _, err := exec.LookPath("gst-launch-1.0"); err != nil {
		return nil, fmt.Errorf("gst-launch-1.0 not found in PATH - install GStreamer (see README)")
	}
	var errs []string
	for _, enc := range candidates(o.Encoder) {
		c, err := launch(o, enc, onUnit, onExit)
		if err == nil {
			return c, nil
		}
		errs = append(errs, fmt.Sprintf("[%s] %v", enc, err))
	}
	return nil, fmt.Errorf("no encoder worked: %s", strings.Join(errs, "; "))
}

func launch(o captureOpts, enc string, onUnit func([]obu), onExit func(error)) (*capture, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer ln.Close()
	desc := buildPipeline(o, enc, ln.Addr().(*net.TCPAddr).Port)
	logf("pipeline: gst-launch-1.0 -q %s", desc)

	cmd := exec.Command("gst-launch-1.0", append([]string{"-q"}, strings.Fields(desc)...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdout = &stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &capture{Encoder: enc, cmd: cmd, done: make(chan struct{})}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()

	tail := func() string {
		s := strings.TrimSpace(stderr.String())
		if len(s) > 600 {
			s = s[len(s)-600:]
		}
		return s
	}

	accepted := make(chan net.Conn, 1)
	go func() {
		if conn, err := ln.Accept(); err == nil {
			accepted <- conn
		}
	}()
	select {
	case conn := <-accepted:
		c.conn = conn
	case err := <-exited:
		return nil, fmt.Errorf("gst-launch exited (%v): %s", err, tail())
	case <-time.After(8 * time.Second):
		c.Stop()
		return nil, fmt.Errorf("pipeline did not start: %s", tail())
	}

	first := make(chan struct{})
	var firstOnce sync.Once
	go func() {
		err := readOBUs(c.conn, func(u []obu) {
			firstOnce.Do(func() { close(first) })
			onUnit(u)
		})
		wasStopped := c.stopped.Load()
		c.Stop()
		<-exited
		close(c.done)
		if onExit != nil && !wasStopped {
			onExit(fmt.Errorf("pipeline died: %v %s", err, tail()))
		}
	}()
	select {
	case <-first:
		return c, nil
	case <-c.done:
		return nil, fmt.Errorf("pipeline died before first frame: %s", tail())
	case <-time.After(6 * time.Second):
		c.Stop()
		return nil, fmt.Errorf("no frames within 6s: %s", tail())
	}
}
