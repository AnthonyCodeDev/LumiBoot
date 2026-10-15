// Gestion de session WISP V1 au-dessus d'une connexion WebSocket.
//
// Protocole implémenté :
//   - envoi immédiat du CONTINUE de stream 0 (taille de buffer initiale),
//     SANS lequel le client v86 bloque tout envoi ;
//   - CONNECT TCP uniquement (le client v86@0.5.471 ne parle QUE TCP) : l'UDP et
//     l'ICMP ne sont pas universels et sont refusés par CLOSE 0x41. Aucune autre
//     promesse n'est faite (pas de promesse UDP/ICMP) ;
//   - dial de l'IP validée par la politique (jamais du hostname) ;
//   - un seul écrivain WebSocket (gorilla interdit les écritures concurrentes) ;
//   - INFO (V2) et types inconnus ignorés.
//
// Concurrence et arrêt :
//   - un contexte de session unique (h.ctx) est annulable par la révocation ou
//     par l'arrêt du serveur (via Close) ;
//   - chaque goroutine est supervisée par compteur (wgProducers/wgWriter) ;
//   - l'arrêt est ordonné et idempotent : arrêt de l'acceptation des trames →
//     annulation des dials/flux → fermeture des sockets → attente des
//     producteurs → arrêt de l'écrivain → fermeture du WebSocket ;
//   - le canal d'envoi n'est fermé que par shutdown, une fois TOUS les
//     producteurs terminés : aucun « send on closed channel » possible ;
//   - une erreur d'écriture WebSocket annule toute la session.
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

// streamState est l'état d'un flux TCP (client <-> réseau).
type streamState struct {
	mu   sync.Mutex
	conn net.Conn // renseigné une fois le dial réussi

	// send transporte les payloads DATA à écrire côté upstream. Il n'est jamais
	// fermé : les producteurs (boucle de lecture) s'arrêtent via closed/ctx.
	send   chan []byte
	closed chan struct{}
	one    sync.Once

	// recvSinceContinue n'est accédé que par la goroutine d'écriture du flux.
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

// Handler exécute une session WISP sur conn. Créer via NewHandler puis Run.
type Handler struct {
	conn *websocket.Conn
	cfg  HandlerConfig

	ctx    context.Context
	cancel context.CancelFunc

	send chan []byte // producteurs -> écrivain unique (fermé uniquement par shutdown)

	wgProducers sync.WaitGroup // watchdog, dials, pumps, écrivains de flux
	wgWriter    sync.WaitGroup // écrivain WebSocket

	mu      sync.Mutex
	streams map[uint32]*streamState

	shutdownOnce sync.Once

	errMu    sync.Mutex
	firstErr error
}

// writeTimeout borne chaque écriture WebSocket.
const writeTimeout = 10 * time.Second

// streamQueueFactor donne une marge au-delà de la fenêtre annoncée : un client
// qui respecte le contrôle de flux ne remplit jamais la file (un débordement
// signale un client qui ignore la fenêtre et entraîne la fermeture du flux).
const streamQueueFactor = 8

// NewHandler construit un handler de session.
func NewHandler(conn *websocket.Conn, cfg HandlerConfig) *Handler {
	h := &Handler{
		conn:    conn,
		cfg:     cfg.withDefaults(),
		send:    make(chan []byte, 128),
		streams: make(map[uint32]*streamState),
	}
	// Contexte de session dès la construction : Close() reste sûr même si la
	// révocation survient avant Run (le callback peut être enregistré avant).
	h.ctx, h.cancel = context.WithCancel(context.Background())
	return h
}

// Close annule la session et ferme immédiatement le WebSocket ainsi que tous
// les net.Conn TCP associés. Idempotent, sûr depuis n'importe quelle goroutine.
// C'est le point d'entrée utilisé par le registre de révocation.
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

// Run exécute la session jusqu'à annulation du parent, erreur WebSocket ou
// fermeture du client. Il envoie d'abord le CONTINUE initial de stream 0.
func (h *Handler) Run(parent context.Context) error {
	// Relie l'annulation du parent (requête HTTP) à la session.
	stop := context.AfterFunc(parent, h.Close)
	defer stop()

	h.wgProducers.Add(1)
	go h.watchdog()

	h.wgWriter.Add(1)
	go h.writeLoop()

	// CONTINUE initial obligatoire : initialise la congestion du client v86.
	h.emit(h.ctx, BuildContinue(0, uint32(h.cfg.InitialBufferPackets)))

	err := h.readLoop()
	h.shutdown()
	if err == nil {
		err = h.recordedErr()
	}
	return err
}

// watchdog débloque ReadMessage dès que la session est annulée.
func (h *Handler) watchdog() {
	defer h.wgProducers.Done()
	<-h.ctx.Done()
	_ = h.conn.Close()
}

// readLoop décode les trames WISP entrantes et les répartit. Il ne réalise
// AUCUNE opération réseau bloquante : dial/DNS sont délégués à des goroutines.
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

// dispatch route une trame décodée. Non bloquant.
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
		// Fenêtre annoncée par le client : on la valide sans la gater (le
		// contrôle de flux est assuré par notre propre fenêtre d'envoi).
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

// handleConnect réserve le flux puis lance la résolution DNS + le dial dans une
// goroutine supervisée : la boucle de lecture reste réactive.
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
		// UDP/ICMP non supportés : le client v86 actuel est TCP-only. On refuse
		// explicitement via CLOSE 0x41 et on ne promet rien d'autre.
		fail(CloseInvalidInfo)
		return
	}
	// Réservation atomique du quota AVANT toute opération réseau.
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

// serveStream résout, compose, puis relaie WS -> TCP ; il démarre aussi le
// relais TCP -> WS (pump). Toute la durée de vie du flux est supervisée.
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

// writeToUpstream relaie les DATA reçues du client vers le flux TCP, en
// respectant la fenêtre d'envoi par flux : un CONTINUE est émis tous les
// InitialBufferPackets paquets traités. Un flux lent ne bloque donc pas la
// boucle de lecture ni les autres flux (traitement par goroutine dédiée).
func (h *Handler) writeToUpstream(streamID uint32, st *streamState, upstream net.Conn) {
	for {
		select {
		case data := <-st.send:
			// Limitation de bande passante AVANT l'écriture, annulable.
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

// handleData enfile un DATA client vers le flux (non bloquant). Un débordement
// de file signale un client ignorant la fenêtre : le flux est fermé.
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
	// payload est déjà une copie privée (DecodeFrame).
	select {
	case st.send <- payload:
	case <-st.closed:
	case <-h.ctx.Done():
	default:
		h.cfg.Stats.IncErrors()
		h.closeStream(streamID, CloseInvalidInfo, true)
	}
}

// pump relaie TCP -> WebSocket (DATA découpés à MaxDataChunk).
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
		// Limitation de bande passante AVANT l'émission, annulable.
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

// writeLoop est l'unique écrivain WebSocket. Toute erreur annule la session :
// le watchdog ferme alors le WebSocket, ce qui débloque ReadMessage, et
// l'annulation du contexte débloque emit et ferme les sockets en attente.
func (h *Handler) writeLoop() {
	defer h.wgWriter.Done()
	failed := false
	for msg := range h.send {
		if failed {
			continue // vidange silencieuse pour ne jamais bloquer les producteurs
		}
		_ = h.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		if err := h.conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
			failed = true
			h.recordErr(err)
			h.cancel()
		}
	}
}

// emit enfile un paquet vers l'écrivain unique. Ne panique jamais : le canal
// n'est fermé qu'après l'arrêt de tous les producteurs (cf. shutdown).
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

// streamExists indique si un flux est déjà suivi.
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
		// Contexte borné : ne jamais bloquer la fermeture sur un pair inerte.
		tmCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		h.emit(tmCtx, BuildClose(id, reason))
		cancel()
	}
}

// shutdown réalise l'arrêt ordonné et idempotent de la session.
func (h *Handler) shutdown() {
	h.shutdownOnce.Do(func() {
		// 1. Stopper l'acceptation des trames et annuler dials/flux.
		h.cancel()
		// 2. Fermer tous les sockets (débloque les pumps bloqués en lecture).
		h.mu.Lock()
		ids := make([]uint32, 0, len(h.streams))
		for id := range h.streams {
			ids = append(ids, id)
		}
		h.mu.Unlock()
		for _, id := range ids {
			h.closeStream(id, 0, false)
		}
		// 3. Attendre tous les producteurs : plus personne n'écrit ensuite.
		h.wgProducers.Wait()
		// 4. Arrêter l'écrivain : SEUL propriétaire de la fermeture du canal.
		close(h.send)
		h.wgWriter.Wait()
		// 5. Fermer le WebSocket.
		_ = h.conn.Close()
	})
}

// writeFull écrit data en entier (Write peut être partiel) et renvoie le nombre
// d'octets réellement écrits. Chaque Write est borné par timeout.
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
