package wisp

import (
	"bytes"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	original := Frame{Type: TypeData, StreamID: 7, Payload: []byte("hello")}
	decoded, err := DecodeFrame(original.Encode(), 1024)
	if err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if decoded.Type != original.Type || decoded.StreamID != original.StreamID {
		t.Fatalf("different header: %+v", decoded)
	}
	if !bytes.Equal(decoded.Payload, original.Payload) {
		t.Fatalf("different payload: %q", decoded.Payload)
	}
}

func TestDecodeFrameTooShort(t *testing.T) {
	if _, err := DecodeFrame([]byte{0x02, 0x01}, 1024); err != ErrFrameTooShort {
		t.Fatalf("expected ErrFrameTooShort, got %v", err)
	}
}

func TestDecodeFrameTooLarge(t *testing.T) {
	f := Frame{Type: TypeData, StreamID: 1, Payload: bytes.Repeat([]byte("x"), 100)}
	if _, err := DecodeFrame(f.Encode(), 16); err == nil {
		t.Fatal("oversized payload accepted")
	}
}

func TestParseConnect(t *testing.T) {
	payload := BuildConnectPayload(StreamTypeTCP, 443, "example.com")
	req, err := ParseConnect(payload)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if req.StreamType != StreamTypeTCP || req.Port != 443 || req.Host != "example.com" {
		t.Fatalf("unexpected request: %+v", req)
	}
}

func TestParseConnectInvalid(t *testing.T) {
	cases := map[string][]byte{
		"empty":      {},
		"too short":  {0x01, 0x50},
		"empty host": BuildConnectPayload(StreamTypeTCP, 80, ""),
		"NUL":        append(BuildConnectPayload(StreamTypeTCP, 80, "a"), 0),
	}
	for name, p := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseConnect(p); err == nil {
				t.Fatal("invalid CONNECT accepted")
			}
		})
	}
}

func TestInitialContinueEncoding(t *testing.T) {
	// The initial CONTINUE (stream 0) required by v86.
	raw := BuildContinue(0, 32)
	f, err := DecodeFrame(raw, 64)
	if err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if f.Type != TypeContinue || f.StreamID != 0 {
		t.Fatalf("unexpected packet: type=%#x stream=%d", f.Type, f.StreamID)
	}
	remaining, err := ParseContinue(f.Payload)
	if err != nil {
		t.Fatalf("CONTINUE payload: %v", err)
	}
	if remaining != 32 {
		t.Fatalf("unexpected window: %d", remaining)
	}
}

func TestParseContinueInvalid(t *testing.T) {
	if _, err := ParseContinue([]byte{1, 2}); err == nil {
		t.Fatal("truncated CONTINUE accepted")
	}
}

func TestParseClose(t *testing.T) {
	raw := BuildClose(3, CloseInvalidInfo)
	f, err := DecodeFrame(raw, 64)
	if err != nil {
		t.Fatalf("decoding: %v", err)
	}
	reason, err := ParseClose(f.Payload)
	if err != nil {
		t.Fatalf("CLOSE payload: %v", err)
	}
	if reason != CloseInvalidInfo {
		t.Fatalf("unexpected reason: %#x", reason)
	}
	if _, err := ParseClose(nil); err == nil {
		t.Fatal("empty CLOSE accepted")
	}
}
