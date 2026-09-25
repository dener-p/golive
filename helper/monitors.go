package main

// monitorInfo describes a capture source for the host UI's source picker. Defined outside
// the platform files so non-Windows builds (which return an empty list) compile too.
type monitorInfo struct {
	Index   int    `json:"index"`
	Name    string `json:"name"` // device path, e.g. \\?\DISPLAY1
	Primary bool   `json:"primary"`
}
