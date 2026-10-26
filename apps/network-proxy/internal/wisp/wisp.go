// Package wisp implements the WISP V1 binary framing as spoken by the client
// embedded in v86@0.5.471.
//
// Packet format: [uint8 type][uint32 stream_id little-endian][payload...]
// Types: CONNECT (0x01), DATA (0x02), CONTINUE (0x03), CLOSE (0x04).
// INFO (0x05) belongs to WISP V2 and must be ignored.
//
// Compatibility reminder: the server MUST send, immediately after the WebSocket
// handshake, a CONTINUE for stream_id 0 carrying the initial buffer size.
// Without it, the v86 client blocks every send (congestion not initialized).
package wisp

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// WISP V1 packet types.
const (
	TypeConnect  byte = 0x01
	TypeData     byte = 0x02
	TypeContinue byte = 0x03
	TypeClose    byte = 0x04
	// TypeInfo belongs to WISP V2: the local network proxy ignores it.
	TypeInfo byte = 0x05
)

// Stream types carried by CONNECT.
const (
	StreamTypeTCP byte = 0x01
	StreamTypeUDP byte = 0x02
)

// Close reasons sent by the client.
const (
	CloseClientDone  byte = 0x02 // voluntary close
	CloseClientError byte = 0x03 // client-side network error
)

// Close reasons sent by the server.
const (
	CloseInvalidInfo        byte = 0x41 // invalid request
	CloseHostUnreachable    byte = 0x42 // host unreachable
	CloseConnectTimeout     byte = 0x43 // connection timeout
	CloseConnectRefused     byte = 0x44 // connection refused
	CloseTransferTimeout    byte = 0x47 // transfer timeout
	CloseDestinationBlocked byte = 0x48 // destination blocked by policy
	CloseThrottled          byte = 0x49 // connection limit reached
)

// HeaderLen is the fixed size of a WISP packet header.
const HeaderLen = 5

// MaxHostLen bounds the length of a host name in CONNECT (RFC 1035: 253).
const MaxHostLen = 253

var (
	// ErrFrameTooShort reports a truncated packet (fewer than 5 bytes).
	ErrFrameTooShort = errors.New("wisp: truncated packet")
	// ErrPayloadTooLarge reports a payload exceeding the configured limit.
	ErrPayloadTooLarge = errors.New("wisp: payload too large")
	// ErrInvalidConnect reports a malformed CONNECT payload.
	ErrInvalidConnect = errors.New("wisp: malformed CONNECT")
	// ErrInvalidContinue reports a malformed CONTINUE payload.
	ErrInvalidContinue = errors.New("wisp: malformed CONTINUE")
	// ErrInvalidClose reports a malformed CLOSE payload.
	ErrInvalidClose = errors.New("wisp: malformed CLOSE")
)

// Frame is a decoded WISP packet.
type Frame struct {
	Type     byte
	StreamID uint32
	Payload  []byte
}

// Encode serializes the packet to the wire format.
func (f Frame) Encode() []byte {
	buf := make([]byte, HeaderLen+len(f.Payload))
	buf[0] = f.Type
	binary.LittleEndian.PutUint32(buf[1:5], f.StreamID)
	copy(buf[5:], f.Payload)
	return buf
}

// DecodeFrame decodes a complete binary WebSocket message into a Frame.
// maxPayload bounds the accepted payload size (memory protection).
func DecodeFrame(buf []byte, maxPayload int) (Frame, error) {
	if len(buf) < HeaderLen {
		return Frame{}, ErrFrameTooShort
	}
	payload := buf[HeaderLen:]
	if len(payload) > maxPayload {
		return Frame{}, fmt.Errorf("%w: %d bytes (max %d)", ErrPayloadTooLarge, len(payload), maxPayload)
	}
	// Defensive copy: the gorilla buffer is reused after reading.
	cp := make([]byte, len(payload))
	copy(cp, payload)
	return Frame{
		Type:     buf[0],
		StreamID: binary.LittleEndian.Uint32(buf[1:5]),
		Payload:  cp,
	}, nil
}

// BuildContinue builds a CONTINUE packet advertising bufferRemaining packets
// still accepted on stream streamID.
func BuildContinue(streamID uint32, bufferRemaining uint32) []byte {
	payload := make([]byte, 4)
	binary.LittleEndian.PutUint32(payload, bufferRemaining)
	return Frame{Type: TypeContinue, StreamID: streamID, Payload: payload}.Encode()
}

// BuildClose builds a CLOSE packet carrying reason.
func BuildClose(streamID uint32, reason byte) []byte {
	return Frame{Type: TypeClose, StreamID: streamID, Payload: []byte{reason}}.Encode()
}

// BuildData builds a DATA packet.
func BuildData(streamID uint32, data []byte) []byte {
	return Frame{Type: TypeData, StreamID: streamID, Payload: data}.Encode()
}

// ConnectRequest is a decoded CONNECT.
type ConnectRequest struct {
	StreamType byte
	Port       uint16
	Host       string
}

// ParseConnect decodes a CONNECT payload:
// [uint8 stream_type][uint16 port LE][hostname UTF-8 without NUL].
func ParseConnect(payload []byte) (ConnectRequest, error) {
	if len(payload) < 3 {
		return ConnectRequest{}, ErrInvalidConnect
	}
	host := string(payload[3:])
	if len(host) == 0 || len(host) > MaxHostLen {
		return ConnectRequest{}, fmt.Errorf("%w: invalid host length", ErrInvalidConnect)
	}
	for i := 0; i < len(host); i++ {
		if host[i] == 0 {
			return ConnectRequest{}, fmt.Errorf("%w: host contains NUL", ErrInvalidConnect)
		}
	}
	return ConnectRequest{
		StreamType: payload[0],
		Port:       binary.LittleEndian.Uint16(payload[1:3]),
		Host:       host,
	}, nil
}

// BuildConnectPayload builds a CONNECT payload (useful for tests).
func BuildConnectPayload(streamType byte, port uint16, host string) []byte {
	payload := make([]byte, 3+len(host))
	payload[0] = streamType
	binary.LittleEndian.PutUint16(payload[1:3], port)
	copy(payload[3:], host)
	return payload
}

// ParseContinue decodes a CONTINUE payload (uint32 LE).
func ParseContinue(payload []byte) (uint32, error) {
	if len(payload) != 4 {
		return 0, ErrInvalidContinue
	}
	return binary.LittleEndian.Uint32(payload), nil
}

// ParseClose decodes a CLOSE payload (uint8 reason).
func ParseClose(payload []byte) (byte, error) {
	if len(payload) != 1 {
		return 0, ErrInvalidClose
	}
	return payload[0], nil
}
