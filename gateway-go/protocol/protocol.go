// Package protocol defines the relay wire protocol shared with the Node
// splicer (server/src/gateway-registry.ts) and the inner terminal protocol
// shared with the browser client. Field names are the wire contract — change
// nothing without changing both sides.
package protocol

import (
	"encoding/binary"
	"encoding/json"
)

// Control is a canvas↔connector text frame.
type Control struct {
	Type      string          `json:"type"`
	ChannelID uint32          `json:"channelId"`
	SessionID string          `json:"sessionId,omitempty"`
	Cols      int             `json:"cols,omitempty"`
	Rows      int             `json:"rows,omitempty"`
	Msg       json.RawMessage `json:"msg,omitempty"`
}

// Inner is a browser↔terminal message (input/resize up; attached/resize/exit down).
type Inner struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// EncodeBinary prefixes pty output with the 4-byte big-endian channel id.
func EncodeBinary(channelID uint32, payload []byte) []byte {
	frame := make([]byte, 4+len(payload))
	binary.BigEndian.PutUint32(frame, channelID)
	copy(frame[4:], payload)
	return frame
}

// DecodeBinary splits a prefixed frame. ok=false for frames under 4 bytes.
func DecodeBinary(frame []byte) (uint32, []byte, bool) {
	if len(frame) < 4 {
		return 0, nil, false
	}
	return binary.BigEndian.Uint32(frame), frame[4:], true
}

// WrapMsg encodes an inner message as a connector→canvas relay-msg frame.
func WrapMsg(channelID uint32, inner any) ([]byte, error) {
	raw, err := json.Marshal(inner)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Control{Type: "relay-msg", ChannelID: channelID, Msg: raw})
}

// RelayClosed encodes the connector→canvas channel-teardown notification.
func RelayClosed(channelID uint32) []byte {
	b, _ := json.Marshal(Control{Type: "relay-closed", ChannelID: channelID})
	return b
}
