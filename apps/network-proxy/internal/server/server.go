// Package server exposes the local network proxy: HTTP pairing and health
// endpoints, plus the WISP WebSocket entry point. Administration (approval,
// revocation) happens in the terminal console (internal/console), without a web
// page. Listens STRICTLY on loopback (validated by config). Graceful shutdown
// via context.
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
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-proxy/internal/auth"
	"github.com/lumiboot/network-proxy/internal/config"
	"github.com/lumiboot/network-proxy/internal/connections"
	"github.com/lumiboot/network-proxy/internal/diagnostics"
	"github.com/lumiboot/network-proxy/internal/wisp"
)

// Version can be overridden at build time (-ldflags "-X ...Version=...").
var Version = "0.1.0-dev"

// WispVersion advertises the supported protocol (V1 only).
const WispVersion = 1

// maxBody bounds JSON request bodies (64 KiB).
const maxBody = 64 * 1024

// Server is the local network proxy server.
type Server struct {
	cfg       config.Config
	auth      *auth.Authenticator
	manager   *connections.Manager
	stats     *diagnostics.Counters
	mux       *http.ServeMux
	upgrader  websocket.Upgrader
	httpSrv   *http.Server
	startTime time.Time

	// ws counts active WISP handlers. http.Server.Shutdown does not wait for
	// hijacked connections (WebSocket): they are closed through the revocation
	// registry, then we wait for their termination on this counter.
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
			// Origin is checked manually before the upgrade (counting + JSON 403).
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
		ReadHeaderTimeout: 10 * time.Second,
		// Internal server logs are filtered so a session token present in a query
		// string can never leak.
		ErrorLog: log.New(redactingWriter{os.Stderr}, "", 0),
	}
	return s, nil
}

// redactingWriter redacts any "token=<value>" before writing: the token must
// never appear in the logs.
type redactingWriter struct{ w io.Writer }

func (rw redactingWriter) Write(p []byte) (int, error) {
	s := string(p)
	for {
		i := strings.Index(strings.ToLower(s), "token=")
		if i < 0 {
			break
		}
		start := i + len("token=")
		end := start
		for end < len(s) && s[end] != ' ' && s[end] != '&' && s[end] != '\n' && s[end] != '\r' {
			end++
		}
		s = s[:start] + "REDACTED" + s[end:]
	}
	return rw.w.Write([]byte(s))
}

// Handler exposes the mux for tests (httptest).
func (s *Server) Handler() http.Handler {
	return securityHeaders(s.preflightMiddleware(s.mux))
}

// Stats exposes the counters (diagnostics, tests).
func (s *Server) Stats() *diagnostics.Counters { return s.stats }

// Authenticator exposes the authenticator (tests).
func (s *Server) Authenticator() *auth.Authenticator { return s.auth }

// Run listens and serves until the context is cancelled (graceful shutdown).
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

// Shutdown explicitly closes every WebSocket session (http.Server does not
// stop hijacked connections), waits for their termination within the ctx
// deadline, then stops the HTTP server.
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

// --- HTTP helpers ---

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "+
				"img-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
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
	return true
}

// setCORS reflects the origin ONLY if allowed. Never "*".
func (s *Server) setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" && s.auth.IsOriginAllowed(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
}

// handlePreflight answers OPTIONS preflights for allowed origins.
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

// preflightMiddleware answers OPTIONS requests (CORS preflight) BEFORE the mux:
// routes are registered per method (Go 1.22+), so OPTIONS would match no route
// and the mux would return 405 without this short-circuit.
func (s *Server) preflightMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			s.handlePreflight(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireAllowedOrigin refuses requests carrying a disallowed origin.
// A missing origin is refused on sensitive endpoints (the LumiBoot provider
// always runs in a browser, which sends Origin).
func (s *Server) requireAllowedOrigin(w http.ResponseWriter, r *http.Request) string {
	origin := r.Header.Get("Origin")
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origin not allowed")
		return ""
	}
	return auth.NormalizeOrigin(origin)
}

// --- routes ---

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
	origin := r.Header.Get("Origin")
	if origin == "" {
		var body struct {
			Origin string `json:"origin"`
		}
		if !decodeBody(w, r, &body) {
			return
		}
		origin = body.Origin
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
	// Status queried by the web page (allowed origin).
	if s.requireAllowedOrigin(w, r) == "" {
		return
	}
	p, ok := s.auth.Status(r.URL.Query().Get("id"))
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

// handleSessionVerify verifies Origin + token WITHOUT an upgrade and returns the
// session expiration. The frontend uses it to stop showing "connected" on a
// mere /health. GET, no custom header (simple CORS request, token in the query,
// like /wisp/).
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

// handleWisp negotiates the WebSocket after checking Origin + token, then runs
// the WISP V1 session. The token travels in the query string because v86 sends
// neither a header nor a subprotocol. The transport is registered with the
// authenticator: Revoke/AdminRevoke/expiration/shutdown actually close the
// WebSocket and all associated TCP net.Conns.
func (s *Server) handleWisp(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origin not allowed")
		return
	}
	token := r.URL.Query().Get("token")
	// Prior check: returns a clear JSON 403 (API behavior).
	if !s.auth.Verify(token, origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "invalid or expired session token")
		return
	}
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

	// Atomic transport registration: if the session was revoked between the
	// verification and the upgrade, the attachment fails and we close.
	// Each WebSocket gets its own transport ID: several connections can share
	// the same token without overwriting each other, and a normal detach only
	// removes that one connection.
	_, transportID, ok := s.auth.AttachSession(token, origin, h.Close)
	if !ok {
		_ = conn.Close()
		s.stats.IncRejectedAuth()
		return
	}
	defer s.auth.DetachSession(token, transportID)

	s.ws.Add(1)
	defer s.ws.Done()
	_ = h.Run(r.Context())
}

func randomToken(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
