package wisp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-proxy/internal/connections"
	"github.com/lumiboot/network-proxy/internal/diagnostics"
	"github.com/lumiboot/network-proxy/internal/security"
)

// pipeDialer simulates a network: every dial returns a net.Pipe whose other end
// echoes.
func pipeDialer() DialFunc {
	return func(_ context.Context, _, _ string) (net.Conn, error) {
		client, server := net.Pipe()
		go func() {
			defer func() { _ = server.Close() }()
			buf := make([]byte, 65536)
			for {
				n, err := server.Read(buf)
				if err != nil {
					return
				}
				if _, err := server.Write(buf[:n]); err != nil {
					return
				}
			}
		}()
		return client, nil
	}
}

func publicResolve(_ context.Context, _ string) ([]net.IP, error) {
	return []net.IP{net.ParseIP("203.0.113.7")}, nil
}

type sessionFixture struct {
	conn   *websocket.Conn
	stats  *diagnostics.Counters
	mgr    *connections.Manager
	cancel context.CancelFunc
}

// newSession mounts a real WISP handler behind a real WebSocket.
func newSession(t *testing.T, mutate func(*HandlerConfig)) *sessionFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	stats := &diagnostics.Counters{}
	mgr := connections.NewManager(16, 8, 0)
	cfg := HandlerConfig{
		InitialBufferPackets: 32,
		MaxDataChunk:         64 * 1024,
		ConnectTimeout:       5 * time.Second,
		IdleTimeout:          30 * time.Second,
		DataTimeout:          5 * time.Second,
		Manager:              mgr,
		Stats:                stats,
		Dial:                 pipeDialer(),
		Resolve:              publicResolve,
		SessionID:            "test",
	}
	if mutate != nil {
		mutate(&cfg)
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(_ *http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		_ = NewHandler(conn, cfg).Run(ctx)
	}))
	t.Cleanup(func() { cancel(); srv.Close() })

	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	wsURL := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/wisp/"
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &sessionFixture{conn: conn, stats: stats, mgr: mgr, cancel: cancel}
}

func readFrame(t *testing.T, conn *websocket.Conn) Frame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("WS read: %v", err)
	}
	f, err := DecodeFrame(msg, 4*1024*1024)
	if err != nil {
		t.Fatalf("decoding: %v", err)
	}
	return f
}

func sendFrame(t *testing.T, conn *websocket.Conn, f Frame) {
	t.Helper()
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteMessage(websocket.BinaryMessage, f.Encode()); err != nil {
		t.Fatalf("WS write: %v", err)
	}
}

func expectClose(t *testing.T, f Frame, stream uint32, reason byte) {
	t.Helper()
	if f.Type != TypeClose || f.StreamID != stream {
		t.Fatalf("CLOSE expected on stream %d, got type=%#x stream=%d", stream, f.Type, f.StreamID)
	}
	got, err := ParseClose(f.Payload)
	if err != nil {
		t.Fatalf("CLOSE payload: %v", err)
	}
	if got != reason {
		t.Fatalf("expected reason %#x, got %#x", reason, got)
	}
}

func TestInitialContinue(t *testing.T) {
	fx := newSession(t, nil)
	f := readFrame(t, fx.conn)
	if f.Type != TypeContinue || f.StreamID != 0 {
		t.Fatalf("initial CONTINUE expected, got type=%#x stream=%d", f.Type, f.StreamID)
	}
	if n, _ := ParseContinue(f.Payload); n != 32 {
		t.Fatalf("unexpected initial window: %d", n)
	}
}

func TestConnectDataCloseEcho(t *testing.T) {
	fx := newSession(t, nil)
	_ = readFrame(t, fx.conn) // initial CONTINUE

	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 1, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	sendFrame(t, fx.conn, Frame{Type: TypeData, StreamID: 1, Payload: []byte("ping-echo")})
	echo := readFrame(t, fx.conn)
	if echo.Type != TypeData || echo.StreamID != 1 || string(echo.Payload) != "ping-echo" {
		t.Fatalf("unexpected echo: %+v", echo)
	}
	if got := fx.stats.Snapshot(); got.TotalConnections != 1 {
		t.Fatalf("connection counter: %+v", got)
	}

	// Client CLOSE then DATA on a closed stream -> CLOSE 0x41.
	sendFrame(t, fx.conn, Frame{Type: TypeClose, StreamID: 1, Payload: []byte{CloseClientDone}})
	sendFrame(t, fx.conn, Frame{Type: TypeData, StreamID: 1, Payload: []byte("too-late")})
	expectClose(t, readFrame(t, fx.conn), 1, CloseInvalidInfo)
}

func TestUDPRefused(t *testing.T) {
	fx := newSession(t, nil)
	_ = readFrame(t, fx.conn)
	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 3, Payload: BuildConnectPayload(StreamTypeUDP, 53, "example.com")})
	expectClose(t, readFrame(t, fx.conn), 3, CloseInvalidInfo)
}

func TestZeroAndDuplicateStreamRefused(t *testing.T) {
	fx := newSession(t, nil)
	_ = readFrame(t, fx.conn)
	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 0, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	expectClose(t, readFrame(t, fx.conn), 0, CloseInvalidInfo)

	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 1, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 1, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	expectClose(t, readFrame(t, fx.conn), 1, CloseInvalidInfo)
	// The first stream remains usable.
	sendFrame(t, fx.conn, Frame{Type: TypeData, StreamID: 1, Payload: []byte("ok")})
	echo := readFrame(t, fx.conn)
	if echo.Type != TypeData || string(echo.Payload) != "ok" {
		t.Fatalf("original stream broken: %+v", echo)
	}
}

func TestInfoIgnored(t *testing.T) {
	fx := newSession(t, nil)
	_ = readFrame(t, fx.conn)
	// INFO (V2): no packet back, session still alive.
	sendFrame(t, fx.conn, Frame{Type: TypeInfo, StreamID: 0, Payload: []byte{0x00, 0x01}})
	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 5, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	sendFrame(t, fx.conn, Frame{Type: TypeData, StreamID: 5, Payload: []byte("alive")})
	echo := readFrame(t, fx.conn)
	if echo.Type != TypeData || string(echo.Payload) != "alive" {
		t.Fatalf("session broken after INFO: %+v", echo)
	}
}

func TestBlockedDestination(t *testing.T) {
	fx := newSession(t, func(c *HandlerConfig) {
		c.Resolve = func(_ context.Context, _ string) ([]net.IP, error) {
			return []net.IP{net.ParseIP("169.254.169.254")}, nil
		}
	})
	_ = readFrame(t, fx.conn)
	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 1, Payload: BuildConnectPayload(StreamTypeTCP, 80, "internal.local")})
	expectClose(t, readFrame(t, fx.conn), 1, security.ReasonDestinationBlocked)
	if got := fx.stats.Snapshot().BlockedDestinations; got != 1 {
		t.Fatalf("blocked destinations: %d", got)
	}
}

func TestConnectRefused(t *testing.T) {
	fx := newSession(t, func(c *HandlerConfig) {
		c.Dial = func(_ context.Context, _, _ string) (net.Conn, error) {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
		}
	})
	_ = readFrame(t, fx.conn)
	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 1, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	expectClose(t, readFrame(t, fx.conn), 1, CloseConnectRefused)
}

// TestFlowControlContinueEmission verifies the per-stream CONTINUE emission:
// after InitialBufferPackets processed frames, a CONTINUE advertising the window
// is emitted, without blocking the echoes.
func TestFlowControlContinueEmission(t *testing.T) {
	fx := newSession(t, func(c *HandlerConfig) { c.InitialBufferPackets = 3 })
	_ = readFrame(t, fx.conn) // initial stream 0 CONTINUE

	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 1, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	for i := 0; i < 3; i++ {
		sendFrame(t, fx.conn, Frame{Type: TypeData, StreamID: 1, Payload: []byte("x")})
	}

	seenContinue := false
	dataCount := 0
	for !seenContinue || dataCount != 3 {
		f := readFrame(t, fx.conn)
		switch {
		case f.Type == TypeData && f.StreamID == 1:
			dataCount++
		case f.Type == TypeContinue && f.StreamID == 1:
			if n, _ := ParseContinue(f.Payload); n != 3 {
				t.Fatalf("unexpected CONTINUE window: %d", n)
			}
			seenContinue = true
		default:
			t.Fatalf("unexpected packet: %+v", f)
		}
	}
}

// TestConcurrentCloseNoPanic closes the session during an active transfer on
// several streams: non-regression for "send on closed channel" / double close.
func TestConcurrentCloseNoPanic(t *testing.T) {
	fx := newSession(t, nil)
	_ = readFrame(t, fx.conn)

	for id := uint32(1); id <= 5; id++ {
		sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: id, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	}

	// Background reader: absorbs echoes so the socket does not saturate.
	stopRead := make(chan struct{})
	go func() {
		for {
			select {
			case <-stopRead:
				return
			default:
			}
			_ = fx.conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
			if _, _, err := fx.conn.ReadMessage(); err != nil {
				if isTimeout(err) {
					continue
				}
				return
			}
		}
	}()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 300; i++ {
			id := uint32(1 + i%5)
			_ = fx.conn.SetWriteDeadline(time.Now().Add(time.Second))
			if err := fx.conn.WriteMessage(websocket.BinaryMessage, Frame{Type: TypeData, StreamID: id, Payload: []byte("load")}.Encode()); err != nil {
				return
			}
		}
	}()

	time.Sleep(10 * time.Millisecond)
	fx.cancel() // concurrent close during the transfer
	wg.Wait()
	close(stopRead)
}

// scriptedConn is a test net.Conn that writes partially then, once errAt is
// reached, returns an error.
type scriptedConn struct {
	mu          sync.Mutex
	maxPerWrite int
	errAt       int
	written     int
	buf         bytes.Buffer
}

var errScripted = errors.New("scripted: write error")

func (c *scriptedConn) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.errAt > 0 && c.written >= c.errAt {
		return 0, errScripted
	}
	n := c.maxPerWrite
	if n <= 0 || n > len(p) {
		n = len(p)
	}
	c.buf.Write(p[:n])
	c.written += n
	return n, nil
}

func (c *scriptedConn) Read([]byte) (int, error)         { return 0, io.EOF }
func (c *scriptedConn) Close() error                     { return nil }
func (c *scriptedConn) LocalAddr() net.Addr              { return dummyAddr{} }
func (c *scriptedConn) RemoteAddr() net.Addr             { return dummyAddr{} }
func (c *scriptedConn) SetDeadline(time.Time) error      { return nil }
func (c *scriptedConn) SetReadDeadline(time.Time) error  { return nil }
func (c *scriptedConn) SetWriteDeadline(time.Time) error { return nil }

type dummyAddr struct{}

func (dummyAddr) Network() string { return "test" }
func (dummyAddr) String() string  { return "test" }

func TestWriteFullPartial(t *testing.T) {
	t.Parallel()
	conn := &scriptedConn{maxPerWrite: 3}
	data := []byte("abcdefghij")
	n, err := writeFull(conn, data, time.Second)
	if err != nil {
		t.Fatalf("writeFull: %v", err)
	}
	if n != len(data) {
		t.Fatalf("bytes written: %d, expected %d", n, len(data))
	}
	if conn.buf.String() != string(data) {
		t.Fatalf("data: %q", conn.buf.String())
	}
}

func TestWriteFullErrorPartial(t *testing.T) {
	t.Parallel()
	conn := &scriptedConn{maxPerWrite: 2, errAt: 2}
	data := []byte("abcdef")
	n, err := writeFull(conn, data, time.Second)
	if !errors.Is(err, errScripted) {
		t.Fatalf("error expected, got %v", err)
	}
	if n != 2 {
		t.Fatalf("partial bytes counted: %d, expected 2", n)
	}
}
