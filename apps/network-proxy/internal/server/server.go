// Package server exposes the local network proxy: HTTP pairing and health
// endpoints, plus the WISP WebSocket entry point. Listens on loopback unless
// `allowNonLoopback` is set; administration happens in the terminal console.
package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-proxy/internal/auth"
	"github.com/lumiboot/network-proxy/internal/config"
	"github.com/lumiboot/network-proxy/internal/connections"
	"github.com/lumiboot/network-proxy/internal/diagnostics"
	"github.com/lumiboot/network-proxy/internal/wisp"
)

// Version can be overridden at build time with -ldflags.
var Version = "0.1.0-dev"

// WispVersion advertises the supported protocol version.
const WispVersion = 1

// maxBody bounds JSON request bodies to 64 KiB.
const maxBody = 64 * 1024

// HTTP server deadlines. WriteTimeout does not affect upgraded WebSockets:
// gorilla/websocket clears the deadlines set by net/http after hijacking.
const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 15 * time.Second
	writeTimeout      = 30 * time.Second
	idleTimeout       = 120 * time.Second
	maxHeaderBytes    = 16 << 10
)

type Server struct {
	cfg       config.Config
	auth      *auth.Authenticator
	manager   *connections.Manager
	stats     *diagnostics.Counters
	mux       *http.ServeMux
	upgrader  websocket.Upgrader
	httpSrv   *http.Server
	startTime time.Time

	// ws counts active WISP handlers: Shutdown does not wait for hijacked
	// WebSockets, so their termination is awaited here.
	ws sync.WaitGroup
}

// New validates the configuration and builds the server.
func New(cfg config.Config) (*Server, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	s := &Server{
		cfg:       cfg,
		auth:      auth.NewAuthenticator(cfg.AllowedOrigins, cfg.PairingTTL.Std(), cfg.SessionTokenTTL.Std()),
		manager:   connections.NewManager(cfg.MaxConnections, cfg.MaxConnectionsPerSession, cfg.BandwidthLimitBytesPerSecond),
		stats:     &diagnostics.Counters{},
		startTime: time.Now(),
		upgrader: websocket.Upgrader{
			// Origin is checked manually before the upgrade to return a JSON 403.
			CheckOrigin:     func(_ *http.Request) bool { return true },
			ReadBufferSize:  32 * 1024,
			WriteBufferSize: 32 * 1024,
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /api/pair/request", s.handlePairRequest)
	mux.HandleFunc("GET /api/pair/status", s.handlePairStatus)
	mux.HandleFunc("POST /api/pair/exchange", s.handlePairExchange)
	mux.HandleFunc("POST /api/session/revoke", s.handleSessionRevoke)
	mux.HandleFunc("GET /api/session/verify", s.handleSessionVerify)
	mux.HandleFunc("GET /wisp/", s.handleWisp)
	mux.HandleFunc("GET /wisp", s.handleWisp)
	s.mux = mux
	s.httpSrv = &http.Server{
		Handler:           securityHeaders(s.preflightMiddleware(mux)),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		// Filtered so a session token in a query string can never leak.
		ErrorLog: log.New(redactingWriter{os.Stderr}, "", 0),
	}
	return s, nil
}

// tokenQueryPattern matches a session token in a query string. It is compiled
// once and applied to raw bytes: a case-folding pass such as strings.ToLower can
// change the byte length of a non-ASCII character before "token=", which would
// shift every offset and split the output mid-rune. \s covers the space, tab,
// CR and LF terminators, & ends the parameter.
var tokenQueryPattern = regexp.MustCompile(`(?i)token=[^&\s]*`)

// redactingWriter redacts any "token=<value>" before writing.
type redactingWriter struct{ w io.Writer }

func (rw redactingWriter) Write(p []byte) (int, error) {
	redacted := tokenQueryPattern.ReplaceAll(p, []byte("token=REDACTED"))
	n, err := rw.w.Write(redacted)
	if err != nil {
		return 0, err
	}
	if n != len(redacted) {
		return 0, io.ErrShortWrite
	}
	return len(p), nil
}

// Handler exposes the mux for tests.
func (s *Server) Handler() http.Handler {
	return securityHeaders(s.preflightMiddleware(s.mux))
}

// Stats exposes the counters.
func (s *Server) Stats() *diagnostics.Counters { return s.stats }

// Authenticator exposes the authenticator for tests.
func (s *Server) Authenticator() *auth.Authenticator { return s.auth }

// Run listens and serves until the context is cancelled.
func (s *Server) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.cfg.ListenAddr)
	if err != nil {
		return err
	}
	defer func() { _ = ln.Close() }()

	// Periodic sweep of idle streams and expired secrets.
	sweepTicker := time.NewTicker(sweepInterval(s.cfg.IdleTimeout.Std()))
	defer sweepTicker.Stop()
	cleanTicker := time.NewTicker(time.Minute)
	defer cleanTicker.Stop()
	go func() {
		for {
			select {
			case <-sweepTicker.C:
				s.manager.SweepIdle(s.cfg.IdleTimeout.Std())
			case <-cleanTicker.C:
				s.auth.CleanupExpired()
			case <-ctx.Done():
				return
			}
		}
	}()

	errCh := make(chan error, 1)
	go func() { errCh <- s.httpSrv.Serve(ln) }()

	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.Shutdown(shutCtx)
		<-errCh
		return nil
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

// Shutdown closes every WebSocket session and waits for their termination;
// http.Server alone does not stop hijacked connections.
func (s *Server) Shutdown(ctx context.Context) {
	s.auth.CloseAllSessions()
	done := make(chan struct{})
	go func() {
		s.ws.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	_ = s.httpSrv.Shutdown(ctx)
}

func sweepInterval(idle time.Duration) time.Duration {
	if half := idle / 2; half >= 5*time.Second {
		return half
	}
	return 5 * time.Second
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		// The proxy only serves JSON and WebSocket upgrades: nothing may load.
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		// No Strict-Transport-Security on purpose: the proxy listens on plain
		// HTTP over loopback, and a browser would then force HTTPS on that host.
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	// Some bodies carry secrets (session tokens, user codes): never cache them.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

// setCORS reflects the origin only if it is allowed. Never "*".
func (s *Server) setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" && s.auth.IsOriginAllowed(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
}

func (s *Server) handlePreflight(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodOptions {
		return false
	}
	s.setCORS(w, r)
	origin := r.Header.Get("Origin")
	if origin != "" && s.auth.IsOriginAllowed(origin) {
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
	} else {
		writeError(w, http.StatusForbidden, "origin not allowed")
	}
	return true
}

// preflightMiddleware answers OPTIONS before the mux: routes are registered per
// method, so OPTIONS would otherwise return 405.
func (s *Server) preflightMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			s.handlePreflight(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireAllowedOrigin refuses a disallowed origin; a missing origin is refused
// too, since the provider always runs in a browser and sends one.
func (s *Server) requireAllowedOrigin(w http.ResponseWriter, r *http.Request) string {
	origin := r.Header.Get("Origin")
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origin not allowed")
		return ""
	}
	return auth.NormalizeOrigin(origin)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	snap := s.stats.Snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":            "ok",
		"version":           Version,
		"wispVersion":       WispVersion,
		"uptimeSeconds":     int64(time.Since(s.startTime).Seconds()),
		"activeConnections": snap.ActiveConnections,
		"counters":          snap,
	})
}

func (s *Server) handlePairRequest(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	// The origin must come from the header, which the browser controls; a body
	// field would let any caller claim someone else's origin.
	origin := r.Header.Get("Origin")
	if origin == "" {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusBadRequest, "missing Origin header")
		return
	}
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origin not allowed")
		return
	}
	p, err := s.auth.RequestPairing(origin)
	if err != nil {
		s.stats.IncRejectedAuth()
		if errors.Is(err, auth.ErrPairingLimit) {
			writeError(w, http.StatusTooManyRequests, "too many pending pairing requests")
			return
		}
		writeError(w, http.StatusForbidden, "origin not allowed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"pairingId": p.ID,
		"userCode":  p.UserCode,
		"expiresAt": p.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handlePairStatus(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	origin := s.requireAllowedOrigin(w, r)
	if origin == "" {
		return
	}
	// The pairing is bound to the origin that requested it: another allowed
	// origin must not be able to read its status.
	p, ok := s.auth.StatusFor(r.URL.Query().Get("id"), origin)
	if !ok {
		writeError(w, http.StatusNotFound, "pairing not found or expired")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    p.Status,
		"expiresAt": p.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handlePairExchange(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	origin := s.requireAllowedOrigin(w, r)
	if origin == "" {
		return
	}
	var body struct {
		PairingID string `json:"pairingId"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	token, expiresAt, err := s.auth.Exchange(body.PairingID, r.Header.Get("Origin"))
	if err != nil {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "exchange failed (unknown, expired or unapproved pairing, or different origin)")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":     token,
		"expiresAt": expiresAt.UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleSessionRevoke(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	// Same origin gate as the other sensitive routes: a token alone is not
	// enough if the caller is not an allowed browser origin.
	if s.requireAllowedOrigin(w, r) == "" {
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	// Self-revocation by possession of the raw token.
	if body.Token != "" && s.auth.Revoke(body.Token) {
		writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
		return
	}
	writeError(w, http.StatusNotFound, "session not found")
}

// handleSessionVerify checks Origin and token without an upgrade, so the frontend
// stops showing "connected" on a mere /health.
func (s *Server) handleSessionVerify(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	origin := r.Header.Get("Origin")
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origin not allowed")
		return
	}
	info, ok := s.auth.VerifySession(r.URL.Query().Get("token"), origin)
	if !ok {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusUnauthorized, "invalid or expired session token")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"expiresAt": info.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// handleWisp negotiates the WebSocket after checking Origin and token, then runs
// the WISP session; the token travels in the query because v86 sends no header.
func (s *Server) handleWisp(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origin not allowed")
		return
	}
	token := r.URL.Query().Get("token")
	// Prior check: returns a clear JSON 403.
	if !s.auth.Verify(token, origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "invalid or expired session token")
		return
	}

	// Counted before the attachment and the upgrade: Shutdown must never miss a
	// connection that is already hijacked.
	s.ws.Add(1)
	defer s.ws.Done()

	// The transport is attached before the handshake so the per-token cap is
	// reported as a clean JSON error instead of a failed upgrade. The closer is
	// bound to the handler once the connection exists.
	closer := &wsCloser{}
	_, transportID, ok := s.auth.AttachSession(token, origin, closer.Close)
	if !ok {
		s.stats.IncRejectedAuth()
		if !s.auth.Verify(token, origin) {
			// Revoked between the check and the attachment.
			writeError(w, http.StatusForbidden, "invalid or expired session token")
			return
		}
		writeError(w, http.StatusTooManyRequests, "too many active connections for this session")
		return
	}
	defer s.auth.DetachSession(token, transportID)

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	sessionID, err := randomToken(8)
	if err != nil {
		_ = conn.Close()
		return
	}
	h := wisp.NewHandler(conn, wisp.HandlerConfig{
		InitialBufferPackets: s.cfg.InitialBufferPackets,
		MaxDataChunk:         s.cfg.MaxDataChunk,
		ConnectTimeout:       s.cfg.ConnectTimeout.Std(),
		IdleTimeout:          s.cfg.IdleTimeout.Std(),
		DataTimeout:          s.cfg.DataTimeout.Std(),
		AllowPrivateNetworks: s.cfg.AllowPrivateNetworks,
		Manager:              s.manager,
		Stats:                s.stats,
		SessionID:            sessionID,
	})
	if !closer.bind(conn, h) {
		// The session was revoked between the attachment and the handshake.
		_ = conn.Close()
		return
	}
	_ = h.Run(r.Context())
}

// wsCloser bridges the transport registered before the WebSocket handshake with
// the WISP handler created after it. Close is idempotent through auth's
// transport wrapper, but remains safe when called before bind.
type wsCloser struct {
	mu      sync.Mutex
	conn    *websocket.Conn
	handler *wisp.Handler
	closed  bool
}

func (c *wsCloser) Close() {
	c.mu.Lock()
	c.closed = true
	h, conn := c.handler, c.conn
	c.mu.Unlock()
	if h != nil {
		h.Close()
	}
	if conn != nil {
		_ = conn.Close()
	}
}

// bind attaches the live connection and handler. It reports false when a
// revocation already fired, so the caller closes the fresh connection.
func (c *wsCloser) bind(conn *websocket.Conn, h *wisp.Handler) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return false
	}
	c.conn = conn
	c.handler = h
	return true
}

func randomToken(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
