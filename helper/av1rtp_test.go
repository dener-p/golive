package main

import (
	"bytes"
	"math/rand"
	"testing"

	"github.com/pion/rtp/codecs"
)

// Round-trip through pion's independent AV1 depacketizer to make sure our packets are valid.
func TestPacketizeRoundTrip(t *testing.T) {
	for _, sizes := range [][]int{{20, 300}, {5000}, {12, 40, 100000}, {1, 1, 1, 1}, {1099, 1100, 1101, 2199, 2200}} {
		var obus []obu
		var want [][]byte
		for i, s := range sizes {
			d := make([]byte, s)
			rand.Read(d)
			typ := byte(6)
			if i == 0 && len(sizes) > 1 {
				typ = 1
			}
			d[0] = typ << 3
			obus = append(obus, obu{typ: typ, data: d})
			want = append(want, d)
		}
		pz := &packetizer{maxPayload: 1100}
		pkts := pz.packetize(obus, 1234)
		if !pkts[len(pkts)-1].Marker {
			t.Fatal("no marker")
		}
		var got [][]byte
		var frag []byte
		for _, p := range pkts {
			if len(p.Payload) > 1100 {
				t.Fatalf("payload too big %d", len(p.Payload))
			}
			var av codecs.AV1Packet
			if _, err := av.Unmarshal(p.Payload); err != nil {
				t.Fatal(err)
			}
			for i, el := range av.OBUElements {
				if i == 0 && av.Z {
					frag = append(frag, el...)
				} else {
					frag = append([]byte{}, el...)
				}
				lastEl := i == len(av.OBUElements)-1
				if lastEl && av.Y {
					continue
				}
				got = append(got, frag)
			}
		}
		if len(got) != len(want) {
			t.Fatalf("sizes %v: got %d OBUs want %d", sizes, len(got), len(want))
		}
		for i := range want {
			if !bytes.Equal(got[i], want[i]) {
				t.Fatalf("sizes %v: obu %d mismatch (%d vs %d bytes)", sizes, i, len(got[i]), len(want[i]))
			}
		}
	}
}
