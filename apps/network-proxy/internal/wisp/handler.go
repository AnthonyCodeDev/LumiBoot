// WISP V1 session handling over a WebSocket connection.
//
// A CONTINUE for stream 0 is sent immediately after the handshake, without which
// the v86 client blocks every send. CONNECT is TCP only: UDP and ICMP are refused
// with CLOSE 0x41, and dialing uses the IP validated by the policy, never the
// hostname. A single goroutine writes to the WebSocket; shutdown is ordered and
// idempotent, and the send channel is only closed once every producer is done.
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

// DialFunc dials a TCP connection to an "ip:port" address.
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

type HandlerConfig struct {
	InitialBufferPackets int
	MaxDataChunk         int
	ConnectTimeout       time.Duration
	IdleTimeout          time.Duration
	DataTimeout          time.Duration
	// AllowPrivateNetworks allows private and loopback, never metadata.
	AllowPrivateNetworks bool
	Manager              *connections.Manager
	Stats                *diagnostics.Counters
	Dial                 DialFunc
	Resolve              security.LookupFunc
	SessionID            string
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

type streamState struct {
	mu   sync.Mutex
	conn net.Conn // set once the dial succeeded

	// send is never closed: producers stop via closed or ctx.
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

type Handler struct {
	conn *websocket.Conn
	cfg  HandlerConfig

	ctx    context.Context
	cancel context.CancelFunc

	send chan []byte // producers -> single writer, closed only by shutdown

	wgProducers sync.WaitGroup // watchdog, dials, pumps, stream writers
	wgWriter    sync.WaitGroup // WebSocket writer

	mu      sync.Mutex
	streams map[uint32]*streamState

	shutdownOnce sync.Once

	errMu    sync.Mutex
	firstErr error
}

const writeTimeout = 10 * time.Second

// streamQueueFactor adds slack beyond the advertised window: an overflow means
// the client ignores flow control.
const streamQueueFactor = 8

// maxConsecutiveEmptyReads bounds upstream reads that keep returning (0, nil):
// a misbehaving net.Conn must not spin the pump goroutine forever.
const maxConsecutiveEmptyReads = 100

func NewHandler(conn *websocket.Conn, cfg HandlerConfig) *Handler {
	h := &Handler{
		conn:    conn,
		cfg:     cfg.withDefaults(),
		send:    make(chan []byte, 128),
		streams: make(map[uint32]*streamState),
	}
	// Session context from construction: Close stays safe before Run.
	h.ctx, h.cancel = context.WithCancel(context.Background())
	return h
}

// Close cancels the session and closes the WebSocket and every TCP net.Conn.
// Idempotent, safe from any goroutine.
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

// Run runs the session until the parent is cancelled or the client closes.
func (h *Handler) Run(parent context.Context) error {
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

// readLoop decodes frames and dispatches them, with no blocking network operation.
// An idle connection is closed after IdleTimeout; pongs (and every other frame)
// push the deadline forward, so only a silent peer is torn down.
func (h *Handler) readLoop() error {
	h.conn.SetReadLimit(int64(h.cfg.MaxDataChunk) + HeaderLen + 1024)
	h.conn.SetPongHandler(func(string) error {
		return h.conn.SetReadDeadline(time.Now().Add(h.cfg.IdleTimeout))
	})
	for {
		if err := h.conn.SetReadDeadline(time.Now().Add(h.cfg.IdleTimeout)); err != nil {
			return err
		}
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
		// The client window is validated but not used: gating is on our own window.
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
	}
}

// handleConnect reserves the stream then resolves and dials in a supervised goroutine,
// so the read loop stays responsive.
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
		// UDP and ICMP are unsupported: the v86 client is TCP only.
		fail(CloseInvalidInfo)
		return
	}
	// Quota is reserved before any network operation.
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

// serveStream resolves, dials, then relays both directions of the stream.
func (h *Handler) serveStream(streamID uint32, st *streamState, req ConnectRequest) {
	defer h.wgProducers.Done()

	connectCtx, cancel := context.WithTimeout(h.ctx, h.cfg.ConnectTimeout)
	defer cancel()
	ip, err := security.ValidateDestination(connectCtx, h.cfg.Resolve, req.Host, int(req.Port), h.cfg.AllowPrivateNetworks)
	if err != nil {
		if errors.Is(connectCtx.Err(), context.DeadlineExceeded) {
			h.closeStream(streamID, CloseConnectTimeout, true)
			return
		}
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
	target := net.JoinHostPort(ip.String(), strconv.Itoa(int(req.Port)))
	upstream, err := dial(connectCtx, "tcp", target)
	connectErr := connectCtx.Err()
	cancel()
	if err != nil {
		switch {
		case errors.Is(connectErr, context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) || isTimeout(err):
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
		h.closeStream(streamID, CloseTransferTimeout, true)
		return
	}
	st.setConn(upstream)

	h.wgProducers.Add(1)
	go h.pump(streamID, st, upstream)

	h.writeToUpstream(streamID, st, upstream)
}

// writeToUpstream relays client DATA to the stream and emits a CONTINUE every
// InitialBufferPackets packets, so a slow stream never blocks the read loop.
func (h *Handler) writeToUpstream(streamID uint32, st *streamState, upstream net.Conn) {
	for {
		select {
		case data := <-st.send:
			// Throttle before the write.
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

// handleData queues a client payload; an overflow means the client ignores the window.
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
	// payload is already a private copy.
	select {
	case st.send <- payload:
	case <-st.closed:
	case <-h.ctx.Done():
	default:
		h.cfg.Stats.IncErrors()
		h.closeStream(streamID, CloseInvalidInfo, true)
	}
}

// pump relays TCP to the WebSocket, splitting DATA at MaxDataChunk.
func (h *Handler) pump(streamID uint32, st *streamState, upstream net.Conn) {
	defer h.wgProducers.Done()
	buf := make([]byte, h.cfg.MaxDataChunk)
	emptyReads := 0
	for {
		_ = upstream.SetReadDeadline(time.Now().Add(h.cfg.IdleTimeout))
		n, err := upstream.Read(buf)
		if n > 0 {
			emptyReads = 0
			// A net.Conn may return data and EOF in the same read. Deliver the
			// data before closing the stream.
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
			emptyReads++
			if emptyReads >= maxConsecutiveEmptyReads {
				h.cfg.Stats.IncErrors()
				h.closeStream(streamID, CloseTransferTimeout, true)
				return
			}
			continue
		}
	}
}

// writeLoop is the single WebSocket writer; any error cancels the session, and the
// watchdog then unblocks ReadMessage. It also pings an idle peer periodically:
// WriteControl may run concurrently with a single writer, so no second writer is
// introduced. A peer that stops answering pings (suspended tab, dropped network)
// lets the read deadline expire.
func (h *Handler) writeLoop() {
	defer h.wgWriter.Done()

	var ping <-chan time.Time
	if interval := h.cfg.IdleTimeout / 3; interval > 0 {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		ping = ticker.C
	}

	failed := false
	for {
		select {
		case msg, ok := <-h.send:
			if !ok {
				return // shutdown closed the queue: every producer is done
			}
			if failed {
				continue // silent drain so producers are never blocked
			}
			_ = h.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := h.conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				failed = true
				h.recordErr(err)
				h.cancel()
			}
		case <-ping:
			if failed {
				continue
			}
			if err := h.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout)); err != nil {
				failed = true
				h.recordErr(err)
				h.cancel()
			}
		}
	}
}

// emit queues a packet for the single writer; it never panics.
func (h *Handler) emit(ctx context.Context, msg []byte) bool {
	// Cancellation is checked before queueing: a frame queued after teardown could
	// race against conn.Close.
	if h.ctx.Err() != nil || ctx.Err() != nil {
		return false
	}
	select {
	case h.send <- msg:
		return true
	case <-ctx.Done():
		return false
	case <-h.ctx.Done():
		return false
	}
}

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

// closeStream closes a stream; notify also sends a CLOSE to the client. Idempotent.
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

func (h *Handler) shutdown() {
	h.shutdownOnce.Do(func() {
		h.cancel()
		h.mu.Lock()
		ids := make([]uint32, 0, len(h.streams))
		for id := range h.streams {
			ids = append(ids, id)
		}
		h.mu.Unlock()
		for _, id := range ids {
			h.closeStream(id, 0, false)
		}
		h.wgProducers.Wait()
		close(h.send)
		h.wgWriter.Wait()
		_ = h.conn.Close()
	})
}

// writeFull writes data entirely, bounding every Write by timeout.
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
