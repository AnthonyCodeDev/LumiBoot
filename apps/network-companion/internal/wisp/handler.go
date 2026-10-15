// Gestion de session WISP V1 au-dessus d'une connexion WebSocket.
//
// Protocole implémenté :
//   - envoi immédiat du CONTINUE de stream 0 (taille de buffer initiale),
//     SANS lequel le client v86 bloque tout envoi ;
//   - CONNECT TCP uniquement (le client v86 ne parle que TCP) : l'UDP est
//     refusé par CLOSE 0x41 ;
//   - dial de l'IP validée par la politique (jamais du hostname) ;
//   - un seul écrivain WebSocket (gorilla interdit les écritures concurrentes) ;
//   - INFO (V2) et types inconnus ignorés.
package wisp

import (
	"context"
	"errors"
	"net"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-companion/internal/connections"
	"github.com/lumiboot/network-companion/internal/diagnostics"
	"github.com/lumiboot/network-companion/internal/security"
)

// DialFunc compose une connexion TCP vers addr ("ip:port").
type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// HandlerConfig paramètre une session WISP.
type HandlerConfig struct {
	// InitialBufferPackets est la fenêtre annoncée (défaut 32).
	InitialBufferPackets int
	// MaxDataChunk borne un payload DATA (défaut 128 Kio).
	MaxDataChunk int
	// ConnectTimeout borne l'établissement TCP (défaut 10 s).
	ConnectTimeout time.Duration
	// IdleTimeout ferme un flux sans activité (défaut 60 s).
	IdleTimeout time.Duration
	// DataTimeout borne chaque lecture/écriture de transfert (défaut 30 s).
	DataTimeout time.Duration
	// AllowPrivateNetworks autorise privé/loopback (jamais les métadonnées).
	AllowPrivateNetworks bool
	// Manager suit les flux (créé par défaut si nil).
	Manager *connections.Manager
	// Stats reçoit les compteurs (créé par défaut si nil).
	Stats *diagnostics.Counters
	// Dial surcharge la composition (tests). Nil = composeur TCP standard.
	Dial DialFunc
	// Resolve surcharge la résolution DNS (tests). Nil = résolveur système.
	Resolve security.LookupFunc
	// SessionID identifie la session WISP pour le quota par session.
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

type streamState struct {
	conn              net.Conn
	recvSinceContinue int
}

// Handler exécute une session WISP sur conn. Créer via NewHandler puis Run.
type Handler struct {
	conn    *websocket.Conn
	cfg     HandlerConfig
	send    chan []byte
	wg      sync.WaitGroup
	mu      sync.Mutex
	streams map[uint32]*streamState
	closeTx sync.Once
}

// writeTimeout borne chaque écriture WebSocket.
const writeTimeout = 10 * time.Second

// NewHandler construit un handler de session.
func NewHandler(conn *websocket.Conn, cfg HandlerConfig) *Handler {
	return &Handler{
		conn:    conn,
		cfg:     cfg.withDefaults(),
		send:    make(chan []byte, 128),
		streams: make(map[uint32]*streamState),
	}
}

// Run exécute la session jusqu'à annulation du contexte, erreur WebSocket ou
// fermeture du client. Il envoie d'abord le CONTINUE initial de stream 0.
func (h *Handler) Run(ctx context.Context) error {
	stop := make(chan struct{})
	defer close(stop)
	// Débloque la lecture si le contexte est annulé.
	go func() {
		select {
		case <-ctx.Done():
			_ = h.conn.Close()
		case <-stop:
		}
	}()

	h.wg.Add(1)
	go h.writeLoop()

	// CONTINUE initial obligatoire : initialise la congestion du client v86.
	if !h.emit(ctx, BuildContinue(0, uint32(h.cfg.InitialBufferPackets))) {
		h.shutdown()
		return ctx.Err()
	}

	h.conn.SetReadLimit(int64(h.cfg.MaxDataChunk) + 1024)
	for {
		msgType, msg, err := h.conn.ReadMessage()
		if err != nil {
			break
		}
		if msgType != websocket.BinaryMessage {
			continue
		}
		frame, err := DecodeFrame(msg, h.cfg.MaxDataChunk+HeaderLen)
		if err != nil {
			h.cfg.Stats.IncErrors()
			continue
		}
		h.dispatch(ctx, frame)
		select {
		case <-ctx.Done():
			break
		default:
		}
		if ctx.Err() != nil {
			break
		}
	}
	h.shutdown()
	return nil
}

// writeLoop est l'unique écrivain WebSocket.
func (h *Handler) writeLoop() {
	defer h.wg.Done()
	for msg := range h.send {
		_ = h.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		if err := h.conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
			return
		}
	}
}

// emit enfile un paquet vers l'écrivain unique.
func (h *Handler) emit(ctx context.Context, msg []byte) bool {
	select {
	case h.send <- msg:
		return true
	case <-ctx.Done():
		return false
	}
}

// shutdown ferme flux, canal d'envoi, écrivain puis connexion.
func (h *Handler) shutdown() {
	h.mu.Lock()
	streams := make([]uint32, 0, len(h.streams))
	for id := range h.streams {
		streams = append(streams, id)
	}
	h.mu.Unlock()
	for _, id := range streams {
		h.closeStream(id, 0, false)
	}
	h.closeTx.Do(func() { close(h.send) })
	h.wg.Wait()
	_ = h.conn.Close()
}

func (h *Handler) dispatch(ctx context.Context, f Frame) {
	switch f.Type {
	case TypeConnect:
		h.handleConnect(ctx, f.StreamID, f.Payload)
	case TypeData:
		h.handleData(ctx, f.StreamID, f.Payload)
	case TypeContinue:
		// Fenêtre du client : la contre-pression TCP suffit, on l'accepte
		// sans gating pour ne jamais bloquer la session.
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
		// WISP V2 : ignoré.
	default:
		// Type inconnu : ignoré (robustesse).
	}
}

func (h *Handler) handleConnect(ctx context.Context, streamID uint32, payload []byte) {
	fail := func(reason byte) {
		h.emit(ctx, BuildClose(streamID, reason))
	}
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
		// UDP non supporté (le client v86 actuel ne parle que TCP).
		fail(CloseInvalidInfo)
		return
	}
	// Réserve le quota avant toute opération réseau.
	if err := h.cfg.Manager.Add(h.cfg.SessionID, streamID, req.Host, req.Port, "", nil); err != nil {
		if errors.Is(err, connections.ErrGlobalLimit) || errors.Is(err, connections.ErrSessionLimit) {
			fail(connections.CloseThrottled)
		} else {
			fail(CloseInvalidInfo)
		}
		h.cfg.Stats.IncErrors()
		return
	}
	release := func(reason byte, blocked bool) {
		h.cfg.Manager.Remove(h.cfg.SessionID, streamID)
		if blocked {
			h.cfg.Stats.IncBlocked()
		}
		fail(reason)
	}

	ip, err := security.ValidateDestination(ctx, h.cfg.Resolve, req.Host, int(req.Port), h.cfg.AllowPrivateNetworks)
	if err != nil {
		var be *security.BlockError
		if errors.As(err, &be) {
			release(be.Reason, be.Reason == security.ReasonDestinationBlocked)
		} else {
			release(CloseHostUnreachable, false)
		}
		return
	}

	dial := h.cfg.Dial
	if dial == nil {
		dialer := &net.Dialer{Timeout: h.cfg.ConnectTimeout}
		dial = dialer.DialContext
	}
	dialCtx, cancel := context.WithTimeout(ctx, h.cfg.ConnectTimeout)
	defer cancel()
	target := net.JoinHostPort(ip.String(), strconv.Itoa(int(req.Port)))
	upstream, err := dial(dialCtx, "tcp", target)
	if err != nil {
		switch {
		case errors.Is(err, context.DeadlineExceeded) || isTimeout(err):
			release(CloseConnectTimeout, false)
		case errors.Is(err, syscall.ECONNREFUSED):
			release(CloseConnectRefused, false)
		default:
			release(CloseHostUnreachable, false)
		}
		h.cfg.Stats.IncErrors()
		return
	}
	if !h.cfg.Manager.SetConn(h.cfg.SessionID, streamID, upstream) {
		_ = upstream.Close()
		return
	}

	h.mu.Lock()
	h.streams[streamID] = &streamState{conn: upstream}
	h.mu.Unlock()
	h.cfg.Stats.IncConnections()

	h.wg.Add(1)
	go h.pump(ctx, streamID, upstream)
}

func (h *Handler) handleData(ctx context.Context, streamID uint32, payload []byte) {
	st := h.getStream(streamID)
	if st == nil {
		h.emit(ctx, BuildClose(streamID, CloseInvalidInfo))
		return
	}
	if len(payload) > h.cfg.MaxDataChunk {
		h.cfg.Stats.IncErrors()
		h.closeStream(streamID, CloseInvalidInfo, true)
		return
	}
	_ = st.conn.SetWriteDeadline(time.Now().Add(h.cfg.DataTimeout))
	if _, err := st.conn.Write(payload); err != nil {
		h.cfg.Stats.IncErrors()
		if isTimeout(err) {
			h.closeStream(streamID, CloseTransferTimeout, true)
		} else {
			h.closeStream(streamID, CloseClientError, true)
		}
		return
	}
	h.cfg.Manager.Throttle(len(payload))
	h.cfg.Manager.AddBytesIn(h.cfg.SessionID, streamID, uint64(len(payload)))
	h.cfg.Stats.AddRX(uint64(len(payload)))

	// Flow-control : un CONTINUE tous les InitialBufferPackets reçus.
	h.mu.Lock()
	st.recvSinceContinue++
	notify := st.recvSinceContinue >= h.cfg.InitialBufferPackets
	if notify {
		st.recvSinceContinue = 0
	}
	h.mu.Unlock()
	if notify {
		h.emit(ctx, BuildContinue(streamID, uint32(h.cfg.InitialBufferPackets)))
	}
}

// pump relaie TCP -> WebSocket (DATA découpés à MaxDataChunk).
func (h *Handler) pump(ctx context.Context, streamID uint32, upstream net.Conn) {
	defer h.wg.Done()
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
		h.cfg.Manager.Throttle(n)
		h.cfg.Manager.AddBytesOut(h.cfg.SessionID, streamID, uint64(n))
		h.cfg.Stats.AddTX(uint64(n))
		frame := BuildData(streamID, buf[:n])
		if !h.emit(ctx, frame) {
			return
		}
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

// closeStream ferme un flux ; notify=true envoie aussi un CLOSE au client.
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
	if st.conn != nil {
		_ = st.conn.Close()
	}
	h.cfg.Manager.Remove(h.cfg.SessionID, id)
	h.cfg.Stats.DecConnections()
	if notify {
		// Contexte borné : ne jamais bloquer la fermeture sur un pair inerte.
		tmCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		h.emit(tmCtx, BuildClose(id, reason))
		cancel()
	}
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
