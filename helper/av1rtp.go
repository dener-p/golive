package main

// AV1 RTP payloading (https://aomediacodec.github.io/av1-rtp-spec/).
//
// We do this ourselves instead of relying on GStreamer's rtpav1pay because that element
// lives in gst-plugins-rs and is missing from many GStreamer builds. Using the plain
// "obu-stream" output of the encoder + this file means the only GStreamer requirement is
// capture + an AV1 encoder + av1parse (all in gst-plugins-bad / base).

import (
	"bufio"
	"errors"
	"fmt"
	"io"

	"github.com/pion/rtp"
)

const (
	obuSequenceHeader = 1
	obuTemporalDelim  = 2
	obuTileGroup      = 4
	obuFrame          = 6
	obuTileList       = 8
	obuPadding        = 15
)

// obu is one OBU with the size field stripped: header byte (+extension byte) + payload.
type obu struct {
	typ  byte
	data []byte
}

func readLeb128(r io.ByteReader) (int, error) {
	v := 0
	for i := 0; i < 8; i++ {
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		v |= int(b&0x7f) << (7 * i)
		if b&0x80 == 0 {
			return v, nil
		}
	}
	return 0, errors.New("bad leb128")
}

func lebLen(n int) int {
	l := 1
	for n >= 0x80 {
		n >>= 7
		l++
	}
	return l
}

func appendLeb(b []byte, n int) []byte {
	for n >= 0x80 {
		b = append(b, byte(n&0x7f)|0x80)
		n >>= 7
	}
	return append(b, byte(n))
}

// readOBUs parses a "low overhead" AV1 OBU stream (every OBU has obu_has_size_field=1,
// which is what GStreamer's stream-format=obu-stream produces) and calls onUnit each time
// a frame is complete. Temporal delimiters are dropped (they must not be sent over RTP).
//
// Flushing on frame completion (instead of waiting for the next temporal delimiter)
// avoids adding one frame of latency.
func readOBUs(r io.Reader, onUnit func([]obu)) error {
	br := bufio.NewReaderSize(r, 1<<20)
	var cur []obu
	for {
		hdr, err := br.ReadByte()
		if err != nil {
			return err
		}
		typ := (hdr >> 3) & 0x0f
		if hdr&0x02 == 0 {
			return errors.New("OBU without size field (stream is not obu-stream)")
		}
		head := []byte{hdr &^ 0x02}
		if hdr&0x04 != 0 {
			ext, err := br.ReadByte()
			if err != nil {
				return err
			}
			head = append(head, ext)
		}
		size, err := readLeb128(br)
		if err != nil {
			return err
		}
		if size > 32<<20 {
			return fmt.Errorf("absurd OBU size %d", size)
		}
		buf := make([]byte, len(head)+size)
		copy(buf, head)
		if _, err := io.ReadFull(br, buf[len(head):]); err != nil {
			return err
		}
		switch typ {
		case obuTemporalDelim:
			if len(cur) > 0 {
				onUnit(cur)
				cur = nil
			}
			continue
		case obuPadding, obuTileList:
			continue
		}
		cur = append(cur, obu{typ: typ, data: buf})
		if typ == obuFrame || typ == obuTileGroup {
			onUnit(cur)
			cur = nil
		}
	}
}

// packetizer turns a frame's OBUs into RTP packets. Aggregation header uses W=0 (every
// OBU element is length-prefixed), which every receiver must support.
type packetizer struct {
	seq        uint16
	maxPayload int
}

func (p *packetizer) packetize(obus []obu, ts uint32) []*rtp.Packet {
	var (
		out      []*rtp.Packet
		body     []byte
		z        bool // first element of the packet continues a fragment
		keyframe bool
	)
	for _, o := range obus {
		if o.typ == obuSequenceHeader {
			keyframe = true
		}
	}
	flush := func(y bool) {
		hdr := byte(0)
		if z {
			hdr |= 0x80
		}
		if y {
			hdr |= 0x40
		}
		if keyframe && len(out) == 0 {
			hdr |= 0x08 // N: new coded video sequence
		}
		out = append(out, &rtp.Packet{
			Header:  rtp.Header{Version: 2, SequenceNumber: p.seq, Timestamp: ts},
			Payload: append([]byte{hdr}, body...),
		})
		p.seq++
		body = nil
		z = false
	}
	for _, o := range obus {
		d := o.data
		for len(d) > 0 {
			avail := p.maxPayload - 1 - len(body)
			if len(body) > 0 && avail < 16 {
				flush(false)
				avail = p.maxPayload - 1
			}
			if lebLen(len(d))+len(d) <= avail {
				body = appendLeb(body, len(d))
				body = append(body, d...)
				d = nil
				continue
			}
			n := avail - 1
			if n >= 128 {
				n = avail - 2
			}
			body = appendLeb(body, n)
			body = append(body, d[:n]...)
			d = d[n:]
			flush(true)
			z = true
		}
	}
	if len(body) > 0 {
		flush(false)
	}
	if len(out) > 0 {
		out[len(out)-1].Marker = true
	}
	return out
}
