//go:build windows

package main

// Monitor enumeration for the capture-source picker. `d3d11screencapturesrc`
// indexes monitors via `monitor-index`; we enumerate in the same order
// EnumDisplayMonitors yields (primary first per Windows conventions) and let the
// host UI show friendly names. On non-Windows we have no picker (see monitors_other.go).

import (
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type monitorInfo struct {
	Index   int    `json:"index"`
	Name    string `json:"name"` // device path, e.g. \\?\DISPLAY1
	Primary bool   `json:"primary"`
}

var (
	user32             = windows.NewLazySystemDLL("user32.dll")
	procEnumMonitors   = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfo = user32.NewProc("GetMonitorInfoW")
)

func enumMonitors() []monitorInfo {
	var out []monitorInfo
	cb := syscall.NewCallback(func(hMonitor, hdc, lprc, dwData uintptr) uintptr {
		// MONITORINFOEXW: cbSize(4) rcMonitor(16) rcWork(16) dwFlags(4) szDevice(64)
		var mi struct {
			cbSize    uint32
			rcMonitor [4]int32
			rcWork    [4]int32
			dwFlags   uint32
			szDevice  [32]uint16
		}
		mi.cbSize = uint32(unsafe.Sizeof(mi))
		r, _, _ := procGetMonitorInfo.Call(hMonitor, uintptr(unsafe.Pointer(&mi)))
		if r == 0 {
			return 1 // keep enumerating
		}
		out = append(out, monitorInfo{
			Name:    windows.UTF16ToString(mi.szDevice[:]),
			Primary: mi.dwFlags&1 != 0, // MONITORINFOF_PRIMARY
		})
		return 1
	})
	procEnumMonitors.Call(0, 0, cb, 0)
	for i := range out {
		out[i].Index = i
	}
	return out
}
