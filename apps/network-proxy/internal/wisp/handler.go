// WISP V1 session handling over a WebSocket connection.
//
// Implemented protocol:
//   - immediate send of the stream 0 CONTINUE (initial buffer size), WITHOUT
//     which the v86 client blocks every send;
//   - CONNECT over TCP only (the v86@0.5.471 client speaks ONLY TCP): UDP and
//     ICMP are not universal and are refused with CLOSE 0x41. Nothing else is
//     promised;
//   - dial the IP validated by the policy (never the hostname);
//   - a single WebSocket writer (gorilla forbids concurrent writes);
//   - INFO (V2) and unknown types are ignored.
//
// Concurrency and shutdown:
//   - a single session context (h.ctx) cancellable by revocation or server
//     shutdown (via Close);
//   - every goroutine is supervised by a counter (wgProducers/wgWriter);
//   - shutdown is ordered and idempotent: stop accepting frames -> cancel
//     dials/streams -> close sockets -> wait for producers -> stop the writer ->
//     close the WebSocket;
//   - the send channel is only closed by shutdown, once ALL producers are done:
//     no "send on closed channel" is possible;
//   - a WebSocket write error cancels the whole session.
package wisp

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-proxy/internal/connections"
	"github.com/lumiboot/network-proxy/internal/diagnostics"
	"github.com/lumiboot/network-proxy/internal/security"
)

// DialFunc dials a TCP connection to addr ("ip:port").
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// HandlerConfig configures a WISP session.
type HandlerConfig struct {
	// InitialBufferPackets is the advertised window (default 32).
	InitialBufferPackets int
	// MaxDataChunk bounds a DATA payload (default 128 KiB).
	MaxDataChunk int
	// ConnectTimeout bounds TCP establishment (default 10 s).
	ConnectTimeout time.Duration
	// IdleTimeout closes a stream without activity (default 60 s).
	IdleTimeout time.Duration
	// DataTimeout bounds every transfer read/write (default 30 s).
	DataTimeout time.Duration
	// AllowPrivateNetworks allows private/loopback (never metadata).
	AllowPrivateNetworks bool
	// Manager tracks streams (created by default if nil).
	Manager *connections.Manager
	// Stats receives the counters (created by default if nil).
	Stats *diagnostics.Counters
	// Dial overrides dialing (tests). Nil = standard TCP dialer.
	Dial DialFunc
	// Resolve overrides DNS resolution (tests). Nil = system resolver.
	Resolve security.LookupFunc
	// SessionID identifies the WISP session for the per-session quota.
	SessionID string
}

func (c HandlerConfig) withDefaults() HandlerConfig {
	if c.InitialBufferPackets <= 0 {
		c.InitialBufferPackets = 32
	}
	if c.MaxDataChunk <= 0 {
		c.MaxDataChunk = 128 * 1024
	}
	if c.ConnectTimeout <= 0 {
		c.ConnectTimeout = 10 * time.Second
	}
	if c.IdleTimeout <= 0 {
		c.IdleTimeout = 60 * time.Second
	}
	if c.DataTimeout <= 0 {
		c.DataTimeout = 30 * time.Second
	}
	if c.Manager == nil {
		c.Manager = connections.NewManager(64, 16, 0)
	}
	if c.Stats == nil {
		c.Stats = &diagnostics.Counters{}
	}
	if c.SessionID == "" {
		c.SessionID = "default"
	}
	return c
}

// streamState is the state of a TCP stream (client <-> network).
type streamState struct {
	mu   sync.Mutex
	conn net.Conn // set once the dial succeeded

	// send carries the DATA payloads to write upstream. It is never closed:
	// producers (read loop) stop via closed/ctx.
	send   chan []byte
	closed chan struct{}
	one    sync.Once

	// recvSinceContinue is only accessed by the stream's write goroutine.
	recvSinceContinue int
}

func newStreamState(queue int) *streamState {
	if queue < 1 {
		queue = 1
	}
	return &streamState{
		send:   make(chan []byte, queue),
		closed: make(chan struct{}),
	}
}

func (s *streamState) markClosed() { s.one.Do(func() { close(s.closed) }) }

func (s *streamState) setConn(c net.Conn) {
	s.mu.Lock()
	s.conn = c
	s.mu.Unlock()
}

func (s *streamState) closeConn() {
	s.mu.Lock()
	c := s.conn
	s.mu.Unlock()
	if c != nil {
		_ = c.Close()
	}
}

// Handler runs a WISP session on conn. Create with NewHandler then Run.
type Handler struct {
	conn *websocket.Conn
	cfg  HandlerConfig

	ctx    context.Context
	cancel context.CancelFunc

	send chan []byte // producers -> single writer (only closed by shutdown)

	wgProducers sync.WaitGroup // watchdog, dials, pumps, stream writers
	wgWriter    sync.WaitGroup // WebSocket writer

	mu      sync.Mutex
	streams map[uint32]*streamState

	shutdownOnce sync.Once

	errMu    sync.Mutex
	firstErr error
}

// writeTimeout bounds every WebSocket write.
const writeTimeout = 10 * time.Second

// streamQueueFactor adds slack beyond the advertised window: a client that
// honors flow control never fills the queue (an overflow signals a client
// ignoring the window and closes the stream).
const streamQueueFactor = 8

// NewHandler builds a session handler.
func NewHandler(conn *websocket.Conn, cfg HandlerConfig) *Handler {
	h := &Handler{
		conn:    conn,
		cfg:     cfg.withDefaults(),
		send:    make(chan []byte, 128),
		streams: make(map[uint32]*streamState),
	}
	// Session context from construction: Close() stays safe even if revocation
	// happens before Run (the callback can be registered earlier).
	h.ctx, h.cancel = context.WithCancel(context.Background())
	return h
}

// Close cancels the session and immediately closes the WebSocket as well as all
// associated TCP net.Conns. Idempotent, safe from any goroutine.
// This is the entry point used by the revocation registry.
func (h *Handler) Close() {
	h.cancel()
	h.mu.Lock()
	conns := make([]*streamState, 0, len(h.streams))
	for _, st := range h.streams {
		conns = append(conns, st)
	}
	h.mu.Unlock()
	for _, st := range conns {
		st.closeConn()
	}
	_ = h.conn.Close()
}

// Run runs the session until the parent is cancelled, a WebSocket error occurs
// or the client closes. It first sends the initial stream 0 CONTINUE.
func (h *Handler) Run(parent context.Context) error {
	// Binds the parent cancellation (HTTP request) to the session.
	stop := context.AfterFunc(parent, h.Close)
	defer stop()

	h.wgProducers.Add(1)
	go h.watchdog()

	h.wgWriter.Add(1)
	go h.writeLoop()

	// Mandatory initial CONTINUE: initializes the v86 client congestion state.
	h.emit(h.ctx, BuildContinue(0, uint32(h.cfg.InitialBufferPackets)))

	err := h.readLoop()
	h.shutdown()
	if err == nil {
		err = h.recordedErr()
	}
	return err
}

// watchdog unblocks ReadMessage as soon as the session is cancelled.
func (h *Handler) watchdog() {
	defer h.wgProducers.Done()
	<-h.ctx.Done()
	_ = h.conn.Close()
}

// readLoop decodes incoming WISP frames and dispatches them. It performs NO
// blocking network operation: dial/DNS are delegated to goroutines.
func (h *Handler) readLoop() error {
	h.conn.SetReadLimit(int64(h.cfg.MaxDataChunk) + HeaderLen + 1024)
	for {
		msgType, msg, err := h.conn.ReadMessage()
		if err != nil {
			return err
		}
		if msgType != websocket.BinaryMessage {
			continue
		}
		frame, err := DecodeFrame(msg, h.cfg.MaxDataChunk+HeaderLen)
		if err != nil {
			h.cfg.Stats.IncErrors()
			continue
		}
		h.dispatch(frame)
		if err := h.ctx.Err(); err != nil {
			return err
		}
	}
}

// dispatch routes a decoded frame. Non-blocking.
func (h *Handler) dispatch(f Frame) {
	if h.ctx.Err() != nil {
		return
	}
	switch f.Type {
	case TypeConnect:
		h.handleConnect(f.StreamID, f.Payload)
	case TypeData:
		h.handleData(f.StreamID, f.Payload)
	case TypeContinue:
		// Window advertised by the client: validated without gating (flow control
		// is provided by our own send window).
		if _, err := ParseContinue(f.Payload); err != nil {
			h.cfg.Stats.IncErrors()
		}
	case TypeClose:
		reason, err := ParseClose(f.Payload)
		if err != nil {
			h.cfg.Stats.IncErrors()
			reason = CloseClientError
		}
		h.closeStream(f.StreamID, reason, false)
	case TypeInfo:
		// WISP V2: ignored.
	default:
		// Unknown type: ignored (robustness).
	}
}

// handleConnect reserves the stream then starts DNS resolution + dial in a
// supervised goroutine: the read loop stays responsive.
func (h *Handler) handleConnect(streamID uint32, payload []byte) {
	fail := func(reason byte) { h.emit(h.ctx, BuildClose(streamID, reason)) }

	if streamID == 0 || h.streamExists(streamID) {
		fail(CloseInvalidInfo)
		h.cfg.Stats.IncErrors()
		return
	}
	req, err := ParseConnect(payload)
	if err != nil {
		fail(CloseInvalidInfo)
		h.cfg.Stats.IncErrors()
		return
	}
	if req.StreamType != StreamTypeTCP {
		// UDP/ICMP unsupported: the current v86 client is TCP-only. Refused
		// explicitly with CLOSE 0x41 and nothing else is promised.
		fail(CloseInvalidInfo)
		return
	}
	// Atomic quota reservation BEFORE any network operation.
	if err := h.cfg.Manager.Add(h.cfg.SessionID, streamID, req.Host, req.Port, "", nil); err != nil {
		if errors.Is(err, connections.ErrGlobalLimit) || errors.Is(err, connections.ErrSessionLimit) {
			fail(connections.CloseThrottled)
		} else {
			fail(CloseInvalidInfo)
		}
		h.cfg.Stats.IncErrors()
		return
	}

	st := newStreamState(h.cfg.InitialBufferPackets + streamQueueFactor)
	h.mu.Lock()
	if _, dup := h.streams[streamID]; dup {
		h.mu.Unlock()
		h.cfg.Manager.Remove(h.cfg.SessionID, streamID)
		fail(CloseInvalidInfo)
		return
	}
	h.streams[streamID] = st
	h.mu.Unlock()
	h.cfg.Stats.IncConnections()

	h.wgProducers.Add(1)
	go h.serveStream(streamID, st, req)
}

// serveStream resolves, dials, then relays WS -> TCP; it also starts the
// TCP -> WS relay (pump). The whole stream lifetime is supervised.
func (h *Handler) serveStream(streamID uint32, st *streamState, req ConnectRequest) {
	defer h.wgProducers.Done()

	ip, err := security.ValidateDestination(h.ctx, h.cfg.Resolve, req.Host, int(req.Port), h.cfg.AllowPrivateNetworks)
	if err != nil {
		var be *security.BlockError
		if errors.As(err, &be) {
			if be.Reason == security.ReasonDestinationBlocked {
				h.cfg.Stats.IncBlocked()
			}
			h.closeStream(streamID, be.Reason, true)
		} else {
			h.closeStream(streamID, CloseHostUnreachable, true)
		}
		return
	}
	if h.getStream(streamID) == nil {
		return
	}

	dial := h.cfg.Dial
	if dial == nil {
		dialer := &net.Dialer{Timeout: h.cfg.ConnectTimeout}
		dial = dialer.DialContext
	}
	dialCtx, cancel := context.WithTimeout(h.ctx, h.cfg.ConnectTimeout)
	target := net.JoinHostPort(ip.String(), strconv.Itoa(int(req.Port)))
	upstream, err := dial(dialCtx, "tcp", target)
	cancel()
	if err != nil {
		switch {
		case errors.Is(err, context.DeadlineExceeded) || isTimeout(err):
			h.closeStream(streamID, CloseConnectTimeout, true)
		case errors.Is(err, syscall.ECONNREFUSED):
			h.closeStream(streamID, CloseConnectRefused, true)
		default:
			h.closeStream(streamID, CloseHostUnreachable, true)
		}
		h.cfg.Stats.IncErrors()
		return
	}
	if h.getStream(streamID) == nil || !h.cfg.Manager.SetConn(h.cfg.SessionID, streamID, upstream) {
		_ = upstream.Close()
		return
	}
	st.setConn(upstream)

	h.wgProducers.Add(1)
	go h.pump(streamID, st, upstream)

	h.writeToUpstream(streamID, st, upstream)
}

// writeToUpstream relays the DATA received from the client to the TCP stream,
// honoring the per-stream send window: a CONTINUE is emitted every
// InitialBufferPackets processed packets. A slow stream therefore does not block
// the read loop or the other streams (dedicated goroutine handling).
func (h *Handler) writeToUpstream(streamID uint32, st *streamState, upstream net.Conn) {
	for {
		select {
		case data := <-st.send:
			// Bandwidth limiting BEFORE the write, cancellable.
			h.cfg.Manager.Throttle(h.ctx, len(data))
			if h.ctx.Err() != nil {
				return
			}
			n, err := writeFull(upstream, data, h.cfg.DataTimeout)
			if n > 0 {
				h.cfg.Manager.AddBytesIn(h.cfg.SessionID, streamID, uint64(n))
				h.cfg.Stats.AddRX(uint64(n))
			}
			if err != nil {
				h.cfg.Stats.IncErrors()
				if isTimeout(err) {
					h.closeStream(streamID, CloseTransferTimeout, true)
				} else {
					h.closeStream(streamID, CloseClientError, true)
				}
				return
			}
			st.recvSinceContinue++
			if st.recvSinceContinue >= h.cfg.InitialBufferPackets {
				st.recvSinceContinue = 0
				if !h.emit(h.ctx, BuildContinue(streamID, uint32(h.cfg.InitialBufferPackets))) {
					return
				}
			}
		case <-st.closed:
			return
		case <-h.ctx.Done():
			return
		}
	}
}

// handleData queues a client DATA payload toward the stream (non-blocking). A
// queue overflow signals a client ignoring the window: the stream is closed.
func (h *Handler) handleData(streamID uint32, payload []byte) {
	st := h.getStream(streamID)
	if st == nil {
		h.emit(h.ctx, BuildClose(streamID, CloseInvalidInfo))
		return
	}
	if len(payload) > h.cfg.MaxDataChunk {
		h.cfg.Stats.IncErrors()
		h.closeStream(streamID, CloseInvalidInfo, true)
		return
	}
	// payload is already a private copy (DecodeFrame).
	select {
	case st.send <- payload:
	case <-st.closed:
	case <-h.ctx.Done():
	default:
		h.cfg.Stats.IncErrors()
		h.closeStream(streamID, CloseInvalidInfo, true)
	}
}

// pump relays TCP -> WebSocket (DATA split at MaxDataChunk).
func (h *Handler) pump(streamID uint32, st *streamState, upstream net.Conn) {
	defer h.wgProducers.Done()
	buf := make([]byte, h.cfg.MaxDataChunk)
	for {
		_ = upstream.SetReadDeadline(time.Now().Add(h.cfg.IdleTimeout))
		n, err := upstream.Read(buf)
		if err != nil {
			if isTimeout(err) {
				h.cfg.Stats.IncErrors()
				h.closeStream(streamID, CloseTransferTimeout, true)
			} else {
				h.closeStream(streamID, CloseClientDone, true)
			}
			return
		}
		if n == 0 {
			continue
		}
		// Bandwidth limiting BEFORE emitting, cancellable.
		h.cfg.Manager.Throttle(h.ctx, n)
		if h.ctx.Err() != nil {
			return
		}
		h.cfg.Manager.AddBytesOut(h.cfg.SessionID, streamID, uint64(n))
		h.cfg.Stats.AddTX(uint64(n))
		if !h.emit(h.ctx, BuildData(streamID, buf[:n])) {
			return
		}
	}
}

// writeLoop is the single WebSocket writer. Any error cancels the session: the
// watchdog then closes the WebSocket, which unblocks ReadMessage, and the
// context cancellation unblocks emit and closes pending sockets.
func (h *Handler) writeLoop() {
	defer h.wgWriter.Done()
	failed := false
	for msg := range h.send {
		if failed {
			continue // silent drain so producers are never blocked
		}
		_ = h.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		if err := h.conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
			failed = true
			h.recordErr(err)
			h.cancel()
		}
	}
}

// emit queues a packet for the single writer. Never panics: the channel is only
// closed after every producer has stopped (see shutdown).
func (h *Handler) emit(ctx context.Context, msg []byte) bool {
	select {
	case h.send <- msg:
		return true
	case <-ctx.Done():
		return false
	case <-h.ctx.Done():
		return false
	}
}

// streamExists reports whether a stream is already tracked.
func (h *Handler) streamExists(id uint32) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.streams[id]
	return ok
}

func (h *Handler) getStream(id uint32) *streamState {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.streams[id]
}

// closeStream closes a stream; notify=true also sends a CLOSE to the client.
// Idempotent.
func (h *Handler) closeStream(id uint32, reason byte, notify bool) {
	h.mu.Lock()
	st, ok := h.streams[id]
	if ok {
		delete(h.streams, id)
	}
	h.mu.Unlock()
	if !ok {
		return
	}
	st.markClosed()
	st.closeConn()
	h.cfg.Manager.Remove(h.cfg.SessionID, id)
	h.cfg.Stats.DecConnections()
	if notify {
		// Bounded context: never block the close on an inert peer.
		tmCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		h.emit(tmCtx, BuildClose(id, reason))
		cancel()
	}
}

// shutdown performs the ordered and idempotent session shutdown.
func (h *Handler) shutdown() {
	h.shutdownOnce.Do(func() {
		// 1. Stop accepting frames and cancel dials/streams.
		h.cancel()
		// 2. Close every socket (unblocks pumps stuck in reads).
		h.mu.Lock()
		ids := make([]uint32, 0, len(h.streams))
		for id := range h.streams {
			ids = append(ids, id)
		}
		h.mu.Unlock()
		for _, id := range ids {
			h.closeStream(id, 0, false)
		}
		// 3. Wait for every producer: nobody writes afterwards.
		h.wgProducers.Wait()
		// 4. Stop the writer: SOLE owner of the channel close.
		close(h.send)
		h.wgWriter.Wait()
		// 5. Close the WebSocket.
		_ = h.conn.Close()
	})
}

// writeFull writes data entirely (Write may be partial) and returns the number
// of bytes actually written. Every Write is bounded by timeout.
func writeFull(conn net.Conn, data []byte, timeout time.Duration) (int, error) {
	written := 0
	for written < len(data) {
		if timeout > 0 {
			_ = conn.SetWriteDeadline(time.Now().Add(timeout))
		}
		n, err := conn.Write(data[written:])
		written += n
		if err != nil {
			return written, err
		}
		if n == 0 {
			return written, io.ErrShortWrite
		}
	}
	return written, nil
}

func (h *Handler) recordErr(err error) {
	h.errMu.Lock()
	if h.firstErr == nil {
		h.firstErr = err
	}
	h.errMu.Unlock()
}

func (h *Handler) recordedErr() error {
	h.errMu.Lock()
	defer h.errMu.Unlock()
	return h.firstErr
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
