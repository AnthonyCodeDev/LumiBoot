// Integration test: a complete WISP V1 session against a real local TCP echo
// server, going through the whole HTTP cycle (pairing -> console approval ->
// exchange -> authenticated WebSocket).
package proxy_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-proxy/internal/config"
	"github.com/lumiboot/network-proxy/internal/server"
	"github.com/lumiboot/network-proxy/internal/wisp"
)

const itOrigin = "http://localhost:5200"

// echoServer starts a TCP echo server on loopback.
func echoServer(t *testing.T) (host string, port int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port
}

// proxyFixture mounts the local network proxy behind httptest.
func proxyFixture(t *testing.T, mutate func(*config.Config)) (*server.Server, *httptest.Server) {
	t.Helper()
	cfg := config.Default()
	cfg.AllowedOrigins = []string{itOrigin}
	// Tests on loopback: local pairing explicitly allowed.
	cfg.AllowLocalOrigins = true
	cfg.AllowPrivateNetworks = true // to reach the local echo; metadata always blocked
	if mutate != nil {
		mutate(&cfg)
	}
	srv, err := server.New(cfg)
	if err != nil {
		t.Fatalf("server: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

// pair runs the full cycle and returns the session token.
func pair(t *testing.T, srv *server.Server, ts *httptest.Server) string {
	t.Helper()
	client := ts.Client()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", itOrigin)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		PairingID string `json:"pairingId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		_ = resp.Body.Close()
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("pair/request: %d", resp.StatusCode)
	}

	// Approval from the console (direct call to the authenticator).
	if err := srv.Authenticator().Approve(created.PairingID, true); err != nil {
		t.Fatalf("pair/approve: %v", err)
	}

	exchange, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/exchange",
		strings.NewReader(`{"pairingId":"`+created.PairingID+`"}`))
	exchange.Header.Set("Origin", itOrigin)
	exchange.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(exchange)
	if err != nil {
		t.Fatal(err)
	}
	var exchanged struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&exchanged); err != nil {
		_ = resp.Body.Close()
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if exchanged.Token == "" {
		t.Fatal("empty token")
	}
	return exchanged.Token
}

func dialWISP(t *testing.T, ts *httptest.Server, token, origin string) *websocket.Conn {
	t.Helper()
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/wisp/?token=" + token
	header := http.Header{}
	if origin != "" {
		header.Set("Origin", origin)
	}
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		if resp != nil {
			_ = resp.Body.Close()
		}
		t.Fatalf("WISP dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func readWISP(t *testing.T, conn *websocket.Conn) wisp.Frame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("WISP read: %v", err)
	}
	f, err := wisp.DecodeFrame(msg, 4*1024*1024)
	if err != nil {
		t.Fatalf("decoding: %v", err)
	}
	return f
}

func sendWISP(t *testing.T, conn *websocket.Conn, f wisp.Frame) {
	t.Helper()
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteMessage(websocket.BinaryMessage, f.Encode()); err != nil {
		t.Fatalf("WISP write: %v", err)
	}
}

func TestFullSession(t *testing.T) {
	srv, ts := proxyFixture(t, nil)
	token := pair(t, srv, ts)
	echoHost, echoPort := echoServer(t)

	conn := dialWISP(t, ts, token, itOrigin)

	// 1. Initial stream 0 CONTINUE (mandatory for v86).
	first := readWISP(t, conn)
	if first.Type != wisp.TypeContinue || first.StreamID != 0 {
		t.Fatalf("initial CONTINUE expected, got type=%#x stream=%d", first.Type, first.StreamID)
	}
	if n, _ := wisp.ParseContinue(first.Payload); n == 0 {
		t.Fatal("zero initial window")
	}

	// 2. CONNECT -> DATA -> CLOSE round trip against the local echo.
	connect := wisp.Frame{
		Type:     wisp.TypeConnect,
		StreamID: 1,
		Payload:  wisp.BuildConnectPayload(wisp.StreamTypeTCP, uint16(echoPort), echoHost),
	}
	sendWISP(t, conn, connect)
	sendWISP(t, conn, wisp.Frame{Type: wisp.TypeData, StreamID: 1, Payload: []byte("hello-echo")})
	echo := readWISP(t, conn)
	if echo.Type != wisp.TypeData || echo.StreamID != 1 || string(echo.Payload) != "hello-echo" {
		t.Fatalf("unexpected echo: %+v", echo)
	}

	// 3. Blocked destination (metadata) -> CLOSE 0x48.
	sendWISP(t, conn, wisp.Frame{
		Type:     wisp.TypeConnect,
		StreamID: 2,
		Payload:  wisp.BuildConnectPayload(wisp.StreamTypeTCP, 80, "169.254.169.254"),
	})
	blocked := readWISP(t, conn)
	if blocked.Type != wisp.TypeClose || blocked.StreamID != 2 {
		t.Fatalf("CLOSE expected, got: %+v", blocked)
	}
	if reason, _ := wisp.ParseClose(blocked.Payload); reason != 0x48 {
		t.Fatalf("expected reason 0x48, got %#x", reason)
	}

	// 4. Clean close of stream 1.
	sendWISP(t, conn, wisp.Frame{Type: wisp.TypeClose, StreamID: 1, Payload: []byte{wisp.CloseClientDone}})
}

func TestWispRejectsBadOriginAndMissingToken(t *testing.T) {
	srv, ts := proxyFixture(t, nil)
	token := pair(t, srv, ts)
	wsBase := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/wisp/?token="

	// Disallowed origin.
	header := http.Header{"Origin": []string{"http://evil.com"}}
	if c, resp, err := websocket.DefaultDialer.Dial(wsBase+token, header); err == nil {
		_ = c.Close()
		t.Fatal("hostile origin accepted")
	} else if resp != nil {
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("hostile origin status: %d", resp.StatusCode)
		}
	}

	// Missing token.
	header = http.Header{"Origin": []string{itOrigin}}
	if c, resp, err := websocket.DefaultDialer.Dial(wsBase, header); err == nil {
		_ = c.Close()
		t.Fatal("missing token accepted")
	} else if resp != nil {
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("missing token status: %d", resp.StatusCode)
		}
	}

	// Rejected-auth counter incremented.
	if got := srv.Stats().Snapshot().RejectedAuth; got < 2 {
		t.Fatalf("rejectedAuth=%d, expected >= 2", got)
	}
}

// trackedEchoServer starts a TCP echo server and reports the close of every
// accepted connection: it verifies that the proxy really cuts the TCP side.
func trackedEchoServer(t *testing.T) (host string, port int, closed <-chan struct{}) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("echo: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	closedCh := make(chan struct{}, 16)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() {
					_ = c.Close()
					closedCh <- struct{}{}
				}()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port, closedCh
}

// expectTransportClosed verifies that both the WebSocket AND the TCP close
// within 5s.
//
// A successful read does NOT mean the session is still open: while the server
// tears the session down it legitimately flushes the WISP frames that explain
// the close (at minimum a CLOSE for the stream, possibly a trailing CONTINUE or
// DATA) before/while closing the socket. Only a read *error* proves the socket
// is gone, so every received frame is tolerated and the attempt is repeated
// until the WebSocket errors out or the global 5s budget is exhausted.
func expectTransportClosed(t *testing.T, conn *websocket.Conn, closed <-chan struct{}, label string) {
	t.Helper()

	const budget = 5 * time.Second
	_ = conn.SetReadDeadline(time.Now().Add(budget))

	last := "none"
	for {
		msgType, msg, err := conn.ReadMessage()
		if err != nil {
			// A read timeout means the deadline expired with the socket still
			// open (no frame, no FIN/RST): this is a real failure.
			if isTimeoutErr(err) {
				t.Fatalf("%s: WebSocket still open after %s (last frame: %s)", label, budget, last)
			}
			break // EOF / RST / close handshake: the WebSocket is closed.
		}
		last = describeWSFrame(msgType, msg)
	}

	select {
	case <-closed:
	case <-time.After(budget):
		t.Fatalf("%s: TCP connection still open (last frame: %s)", label, last)
	}
}

// isTimeoutErr reports whether err is a deadline expiration on the socket.
func isTimeoutErr(err error) bool {
	var nerr net.Error
	return errors.Is(err, os.ErrDeadlineExceeded) || (errors.As(err, &nerr) && nerr.Timeout())
}

// describeWSFrame renders a received WebSocket message for failure messages.
func describeWSFrame(msgType int, msg []byte) string {
	if msgType != websocket.BinaryMessage {
		return fmt.Sprintf("ws type %d, %d bytes", msgType, len(msg))
	}
	f, err := wisp.DecodeFrame(msg, 1<<20)
	if err != nil {
		return fmt.Sprintf("undecodable binary frame, %d bytes", len(msg))
	}
	return fmt.Sprintf("WISP type %#02x stream %d reason/payload %x", f.Type, f.StreamID, f.Payload)
}

// TestExpectTransportClosedToleratesWispCloseFrame guards the helper itself: a
// CLOSE frame flushed by the server while it tears the session down is a
// legitimate end-of-session event, NOT proof that the WebSocket is still open.
// Asserting on the first read made the revocation tests intermittently fail.
func TestExpectTransportClosedToleratesWispCloseFrame(t *testing.T) {
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		_ = c.WriteMessage(websocket.BinaryMessage, wisp.BuildContinue(0, 16))
		_ = c.WriteMessage(websocket.BinaryMessage, wisp.BuildClose(1, wisp.CloseClientDone))
		time.Sleep(50 * time.Millisecond) // let the frames arrive before the FIN
	}))
	defer ts.Close()

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(ts.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	closed := make(chan struct{}, 1)
	closed <- struct{}{}
	expectTransportClosed(t, conn, closed, "close-frame-before-fin")
}

// openEchoStream opens the WISP session, sets up a TCP stream to the local echo
// and confirms establishment with a DATA round trip.
func openEchoStream(t *testing.T, conn *websocket.Conn, echoPort int) {
	t.Helper()
	_ = readWISP(t, conn) // initial CONTINUE
	sendWISP(t, conn, wisp.Frame{
		Type:     wisp.TypeConnect,
		StreamID: 1,
		Payload:  wisp.BuildConnectPayload(wisp.StreamTypeTCP, uint16(echoPort), "127.0.0.1"),
	})
	sendWISP(t, conn, wisp.Frame{Type: wisp.TypeData, StreamID: 1, Payload: []byte("ping")})
	echo := readWISP(t, conn)
	if echo.Type != wisp.TypeData || echo.StreamID != 1 || string(echo.Payload) != "ping" {
		t.Fatalf("stream establishment: %+v", echo)
	}
}

func TestRevocationClosesWebSocketAndTCP(t *testing.T) {
	srv, ts := proxyFixture(t, nil)
	token := pair(t, srv, ts)
	_, echoPort, closed := trackedEchoServer(t)

	conn := dialWISP(t, ts, token, itOrigin)
	openEchoStream(t, conn, echoPort)

	if !srv.Authenticator().Revoke(token) {
		t.Fatal("revocation failed")
	}
	expectTransportClosed(t, conn, closed, "revocation")
}

// TestRevocationClosesMultipleWebSocketsSameToken: P0 regression — two
// WebSockets sharing the same token no longer overwrite each other; revocation
// closes 2/2 (WebSocket and associated TCP).
func TestRevocationClosesMultipleWebSocketsSameToken(t *testing.T) {
	srv, ts := proxyFixture(t, nil)
	token := pair(t, srv, ts)
	_, echoPortA, closedA := trackedEchoServer(t)
	_, echoPortB, closedB := trackedEchoServer(t)

	connA := dialWISP(t, ts, token, itOrigin)
	openEchoStream(t, connA, echoPortA)
	connB := dialWISP(t, ts, token, itOrigin)
	openEchoStream(t, connB, echoPortB)

	if !srv.Authenticator().Revoke(token) {
		t.Fatal("revocation failed")
	}
	expectTransportClosed(t, connA, closedA, "revocation A")
	expectTransportClosed(t, connB, closedB, "revocation B")
}

func TestExpirationClosesTransport(t *testing.T) {
	srv, ts := proxyFixture(t, func(c *config.Config) {
		c.SessionTokenTTL = config.Duration(time.Second)
	})
	token := pair(t, srv, ts)
	_, echoPort, closed := trackedEchoServer(t)

	conn := dialWISP(t, ts, token, itOrigin)
	openEchoStream(t, conn, echoPort)

	time.Sleep(1200 * time.Millisecond) // exceeds SessionTokenTTL
	srv.Authenticator().CleanupExpired()

	expectTransportClosed(t, conn, closed, "expiration")
}

func TestShutdownClosesWebSockets(t *testing.T) {
	srv, ts := proxyFixture(t, nil)
	token := pair(t, srv, ts)
	_, echoPort, closed := trackedEchoServer(t)

	conn := dialWISP(t, ts, token, itOrigin)
	openEchoStream(t, conn, echoPort)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)

	expectTransportClosed(t, conn, closed, "server shutdown")
}

func TestConnectionLimit(t *testing.T) {
	srv, ts := proxyFixture(t, func(c *config.Config) {
		c.MaxConnectionsPerSession = 1
	})
	token := pair(t, srv, ts)
	echoHost, echoPort := echoServer(t)
	conn := dialWISP(t, ts, token, itOrigin)
	_ = readWISP(t, conn) // initial CONTINUE

	mkConnect := func(id uint32) wisp.Frame {
		return wisp.Frame{
			Type:     wisp.TypeConnect,
			StreamID: id,
			Payload:  wisp.BuildConnectPayload(wisp.StreamTypeTCP, uint16(echoPort), echoHost),
		}
	}
	sendWISP(t, conn, mkConnect(1))
	sendWISP(t, conn, mkConnect(2))
	limited := readWISP(t, conn)
	if limited.Type != wisp.TypeClose || limited.StreamID != 2 {
		t.Fatalf("CLOSE 0x49 expected on stream 2, got: %+v", limited)
	}
	if reason, _ := wisp.ParseClose(limited.Payload); reason != 0x49 {
		t.Fatalf("expected reason 0x49, got %#x", reason)
	}
	// The first stream stays functional.
	sendWISP(t, conn, wisp.Frame{Type: wisp.TypeData, StreamID: 1, Payload: []byte("still-there")})
	echo := readWISP(t, conn)
	if echo.Type != wisp.TypeData || string(echo.Payload) != "still-there" {
		t.Fatalf("stream 1 broken: %+v", echo)
	}
}
