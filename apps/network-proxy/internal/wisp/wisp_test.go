package wisp

import (
	"bytes"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	original := Frame{Type: TypeData, StreamID: 7, Payload: []byte("bonjour")}
	decoded, err := DecodeFrame(original.Encode(), 1024)
	if err != nil {
		t.Fatalf("décodage: %v", err)
	}
	if decoded.Type != original.Type || decoded.StreamID != original.StreamID {
		t.Fatalf("en-tête différent: %+v", decoded)
	}
	if !bytes.Equal(decoded.Payload, original.Payload) {
		t.Fatalf("payload différent: %q", decoded.Payload)
	}
}

func TestDecodeFrameTooShort(t *testing.T) {
	if _, err := DecodeFrame([]byte{0x02, 0x01}, 1024); err != ErrFrameTooShort {
		t.Fatalf("attendu ErrFrameTooShort, obtenu %v", err)
	}
}

func TestDecodeFrameTooLarge(t *testing.T) {
	f := Frame{Type: TypeData, StreamID: 1, Payload: bytes.Repeat([]byte("x"), 100)}
	if _, err := DecodeFrame(f.Encode(), 16); err == nil {
		t.Fatal("payload surdimensionné accepté")
	}
}

func TestParseConnect(t *testing.T) {
	payload := BuildConnectPayload(StreamTypeTCP, 443, "example.com")
	req, err := ParseConnect(payload)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if req.StreamType != StreamTypeTCP || req.Port != 443 || req.Host != "example.com" {
		t.Fatalf("requête inattendue: %+v", req)
	}
}

func TestParseConnectInvalid(t *testing.T) {
	cases := map[string][]byte{
		"vide":       {},
		"trop court": {0x01, 0x50},
		"hôte vide":  BuildConnectPayload(StreamTypeTCP, 80, ""),
		"NUL":        append(BuildConnectPayload(StreamTypeTCP, 80, "a"), 0),
	}
	for name, p := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseConnect(p); err == nil {
				t.Fatal("CONNECT invalide accepté")
			}
		})
	}
}

func TestInitialContinueEncoding(t *testing.T) {
	// Le CONTINUE initial (stream 0) exigé par v86.
	raw := BuildContinue(0, 32)
	f, err := DecodeFrame(raw, 64)
	if err != nil {
		t.Fatalf("décodage: %v", err)
	}
	if f.Type != TypeContinue || f.StreamID != 0 {
		t.Fatalf("paquet inattendu: type=%#x stream=%d", f.Type, f.StreamID)
	}
	remaining, err := ParseContinue(f.Payload)
	if err != nil {
		t.Fatalf("payload CONTINUE: %v", err)
	}
	if remaining != 32 {
		t.Fatalf("fenêtre inattendue: %d", remaining)
	}
}

func TestParseContinueInvalid(t *testing.T) {
	if _, err := ParseContinue([]byte{1, 2}); err == nil {
		t.Fatal("CONTINUE tronqué accepté")
	}
}

func TestParseClose(t *testing.T) {
	raw := BuildClose(3, CloseInvalidInfo)
	f, err := DecodeFrame(raw, 64)
	if err != nil {
		t.Fatalf("décodage: %v", err)
	}
	reason, err := ParseClose(f.Payload)
	if err != nil {
		t.Fatalf("payload CLOSE: %v", err)
	}
	if reason != CloseInvalidInfo {
		t.Fatalf("raison inattendue: %#x", reason)
	}
	if _, err := ParseClose(nil); err == nil {
		t.Fatal("CLOSE vide accepté")
	}
}
