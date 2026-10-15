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

// pipeDialer simule un réseau : chaque composition renvoie un net.Pipe dont
// l'autre extrémité fait écho.
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

// newSession monte un handler WISP réel derrière un vrai WebSocket.
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
		t.Fatalf("dial WS: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &sessionFixture{conn: conn, stats: stats, mgr: mgr, cancel: cancel}
}

func readFrame(t *testing.T, conn *websocket.Conn) Frame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("lecture WS: %v", err)
	}
	f, err := DecodeFrame(msg, 4*1024*1024)
	if err != nil {
		t.Fatalf("décodage: %v", err)
	}
	return f
}

func sendFrame(t *testing.T, conn *websocket.Conn, f Frame) {
	t.Helper()
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteMessage(websocket.BinaryMessage, f.Encode()); err != nil {
		t.Fatalf("écriture WS: %v", err)
	}
}

func expectClose(t *testing.T, f Frame, stream uint32, reason byte) {
	t.Helper()
	if f.Type != TypeClose || f.StreamID != stream {
		t.Fatalf("CLOSE attendu sur flux %d, obtenu type=%#x flux=%d", stream, f.Type, f.StreamID)
	}
	got, err := ParseClose(f.Payload)
	if err != nil {
		t.Fatalf("payload CLOSE: %v", err)
	}
	if got != reason {
		t.Fatalf("raison attendue %#x, obtenue %#x", reason, got)
	}
}

func TestInitialContinue(t *testing.T) {
	fx := newSession(t, nil)
	f := readFrame(t, fx.conn)
	if f.Type != TypeContinue || f.StreamID != 0 {
		t.Fatalf("CONTINUE initial attendu, obtenu type=%#x flux=%d", f.Type, f.StreamID)
	}
	if n, _ := ParseContinue(f.Payload); n != 32 {
		t.Fatalf("fenêtre initiale inattendue: %d", n)
	}
}

func TestConnectDataCloseEcho(t *testing.T) {
	fx := newSession(t, nil)
	_ = readFrame(t, fx.conn) // CONTINUE initial

	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 1, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	sendFrame(t, fx.conn, Frame{Type: TypeData, StreamID: 1, Payload: []byte("ping-echo")})
	echo := readFrame(t, fx.conn)
	if echo.Type != TypeData || echo.StreamID != 1 || string(echo.Payload) != "ping-echo" {
		t.Fatalf("écho inattendu: %+v", echo)
	}
	if got := fx.stats.Snapshot(); got.TotalConnections != 1 {
		t.Fatalf("compteur de connexions: %+v", got)
	}

	// CLOSE client puis DATA sur flux fermé -> CLOSE 0x41.
	sendFrame(t, fx.conn, Frame{Type: TypeClose, StreamID: 1, Payload: []byte{CloseClientDone}})
	sendFrame(t, fx.conn, Frame{Type: TypeData, StreamID: 1, Payload: []byte("trop-tard")})
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
	// Le premier flux reste utilisable.
	sendFrame(t, fx.conn, Frame{Type: TypeData, StreamID: 1, Payload: []byte("ok")})
	echo := readFrame(t, fx.conn)
	if echo.Type != TypeData || string(echo.Payload) != "ok" {
		t.Fatalf("flux d'origine cassé: %+v", echo)
	}
}

func TestInfoIgnored(t *testing.T) {
	fx := newSession(t, nil)
	_ = readFrame(t, fx.conn)
	// INFO (V2) : aucun paquet en retour, session toujours vivante.
	sendFrame(t, fx.conn, Frame{Type: TypeInfo, StreamID: 0, Payload: []byte{0x00, 0x01}})
	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 5, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	sendFrame(t, fx.conn, Frame{Type: TypeData, StreamID: 5, Payload: []byte("vivant")})
	echo := readFrame(t, fx.conn)
	if echo.Type != TypeData || string(echo.Payload) != "vivant" {
		t.Fatalf("session cassée après INFO: %+v", echo)
	}
}

func TestBlockedDestination(t *testing.T) {
	fx := newSession(t, func(c *HandlerConfig) {
		c.Resolve = func(_ context.Context, _ string) ([]net.IP, error) {
			return []net.IP{net.ParseIP("169.254.169.254")}, nil
		}
	})
	_ = readFrame(t, fx.conn)
	sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: 1, Payload: BuildConnectPayload(StreamTypeTCP, 80, "interne.local")})
	expectClose(t, readFrame(t, fx.conn), 1, security.ReasonDestinationBlocked)
	if got := fx.stats.Snapshot().BlockedDestinations; got != 1 {
		t.Fatalf("destinations bloquées: %d", got)
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

// TestFlowControlContinueEmission vérifie l'émission du CONTINUE par flux :
// après InitialBufferPackets trames traitées, un CONTINUE annonçant la fenêtre
// est émis, sans bloquer les échos.
func TestFlowControlContinueEmission(t *testing.T) {
	fx := newSession(t, func(c *HandlerConfig) { c.InitialBufferPackets = 3 })
	_ = readFrame(t, fx.conn) // CONTINUE initial stream 0

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
				t.Fatalf("fenêtre CONTINUE inattendue: %d", n)
			}
			seenContinue = true
		default:
			t.Fatalf("paquet inattendu: %+v", f)
		}
	}
}

// TestConcurrentCloseNoPanic ferme la session pendant un transfert actif sur
// plusieurs flux : non-régression « send on closed channel » / double close.
func TestConcurrentCloseNoPanic(t *testing.T) {
	fx := newSession(t, nil)
	_ = readFrame(t, fx.conn)

	for id := uint32(1); id <= 5; id++ {
		sendFrame(t, fx.conn, Frame{Type: TypeConnect, StreamID: id, Payload: BuildConnectPayload(StreamTypeTCP, 80, "example.com")})
	}

	// Lecteur de fond : absorbe les échos pour ne pas saturer la socket.
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
			if err := fx.conn.WriteMessage(websocket.BinaryMessage, Frame{Type: TypeData, StreamID: id, Payload: []byte("charge")}.Encode()); err != nil {
				return
			}
		}
	}()

	time.Sleep(10 * time.Millisecond)
	fx.cancel() // fermeture concurrente pendant le transfert
	wg.Wait()
	close(stopRead)
}

// scriptedConn est un net.Conn de test qui écrit partiellement puis, si errAt
// est atteint, renvoie une erreur.
type scriptedConn struct {
	mu          sync.Mutex
	maxPerWrite int
	errAt       int
	written     int
	buf         bytes.Buffer
}

var errScripted = errors.New("scripted: erreur d'écriture")

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
		t.Fatalf("octets écrits: %d, attendu %d", n, len(data))
	}
	if conn.buf.String() != string(data) {
		t.Fatalf("données: %q", conn.buf.String())
	}
}

func TestWriteFullErrorPartial(t *testing.T) {
	t.Parallel()
	conn := &scriptedConn{maxPerWrite: 2, errAt: 2}
	data := []byte("abcdef")
	n, err := writeFull(conn, data, time.Second)
	if !errors.Is(err, errScripted) {
		t.Fatalf("erreur attendue, obtenue %v", err)
	}
	if n != 2 {
		t.Fatalf("octets partiels comptés: %d, attendu 2", n)
	}
}
