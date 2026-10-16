// Package server expose le proxy réseau local : endpoints HTTP d'appairage et de santé,
// et point d'accès WebSocket WISP. L'administration (approbation, révocation)
// se fait depuis la console du terminal (internal/console), sans page web.
// Écoute STRICTEMENT loopback (validé par config). Arrêt gracieux via contexte.
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

// Version est surchargeable à la compilation (-ldflags "-X ...Version=...").
var Version = "0.1.0-dev"

// WispVersion annonce le protocole supporté (V1 uniquement).
const WispVersion = 1

// maxBody borne les corps de requêtes JSON (64 Kio).
const maxBody = 64 * 1024

// Server est le serveur du proxy réseau local.
type Server struct {
	cfg       config.Config
	auth      *auth.Authenticator
	manager   *connections.Manager
	stats     *diagnostics.Counters
	mux       *http.ServeMux
	upgrader  websocket.Upgrader
	httpSrv   *http.Server
	startTime time.Time

	// ws compte les handlers WISP actifs. http.Server.Shutdown n'attend pas les
	// connexions hijackées (WebSocket) : on les ferme via le registre de
	// révocation puis on attend leur terminaison sous ce compteur.
	ws sync.WaitGroup
}

// New valide la configuration et construit le serveur.
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
			// Origine vérifiée manuellement avant l'upgrade (comptage + 403 JSON).
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
		// Les logs internes du serveur sont filtrés pour ne jamais laisser
		// fuiter un token de session présent dans une query string.
		ErrorLog: log.New(redactingWriter{os.Stderr}, "", 0),
	}
	return s, nil
}

// redactingWriter censure un éventuel « token=<valeur> » avant écriture :
// le token ne doit jamais apparaître dans les logs.
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

// Handler expose le mux pour les tests (httptest).
func (s *Server) Handler() http.Handler {
	return securityHeaders(s.preflightMiddleware(s.mux))
}

// Stats expose les compteurs (diagnostics, tests).
func (s *Server) Stats() *diagnostics.Counters { return s.stats }

// Authenticator expose l'authentificateur (tests).
func (s *Server) Authenticator() *auth.Authenticator { return s.auth }

// Run écoute et sert jusqu'à annulation du contexte (arrêt gracieux).
func (s *Server) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.cfg.ListenAddr)
	if err != nil {
		return err
	}
	defer func() { _ = ln.Close() }()

	// Balayage périodique des flux inactifs et des secrets expirés.
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

// Shutdown ferme explicitement toutes les sessions WebSocket (http.Server
// n'arrête pas les connexions hijackées), attend leur terminaison sous le délai
// de ctx, puis arrête le serveur HTTP.
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

// --- utilitaires HTTP ---

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
		writeError(w, http.StatusBadRequest, "corps JSON invalide")
		return false
	}
	return true
}

// setCORS reflète l'origine UNIQUEMENT si autorisée. Jamais "*".
func (s *Server) setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" && s.auth.IsOriginAllowed(origin) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
}

// handlePreflight répond aux préflights OPTIONS pour les origines autorisées.
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
		writeError(w, http.StatusForbidden, "origine non autorisée")
	}
	return true
}

// preflightMiddleware répond aux requêtes OPTIONS (préflight CORS) AVANT le
// mux : les routes sont enregistrées par méthode (Go 1.22+), donc OPTIONS ne
// matcherait aucune route et le mux renverrait 405 sans ce court-circuit.
func (s *Server) preflightMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			s.handlePreflight(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireAllowedOrigin refuse les requêtes portant une origine non autorisée.
// Une origine absente est refusée sur les endpoints sensibles (le provider
// LumiBoot tourne toujours dans un navigateur, qui envoie Origin).
func (s *Server) requireAllowedOrigin(w http.ResponseWriter, r *http.Request) string {
	origin := r.Header.Get("Origin")
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origine non autorisée")
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
			writeError(w, http.StatusTooManyRequests, "trop de demandes d'appairage en attente")
			return
		}
		writeError(w, http.StatusForbidden, "origine non autorisée")
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
	// Statut consulté par la page web (origine autorisée).
	if s.requireAllowedOrigin(w, r) == "" {
		return
	}
	p, ok := s.auth.Status(r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "appairage introuvable ou expiré")
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
		writeError(w, http.StatusForbidden, "échange impossible (appairage inconnu, expiré, non approuvé ou origine différente)")
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
	// Auto-révocation par possession du token brut.
	if body.Token != "" && s.auth.Revoke(body.Token) {
		writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
		return
	}
	writeError(w, http.StatusNotFound, "session introuvable")
}

// handleSessionVerify vérifie Origin + token SANS upgrade et renvoie
// l'expiration de la session. Le frontend s'en sert pour ne plus afficher
// « connecté » sur un simple /health. GET, pas de header custom (requête simple
// CORS, token en query, comme /wisp/).
func (s *Server) handleSessionVerify(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	origin := r.Header.Get("Origin")
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origine non autorisée")
		return
	}
	info, ok := s.auth.VerifySession(r.URL.Query().Get("token"), origin)
	if !ok {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusUnauthorized, "token de session invalide ou expiré")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"expiresAt": info.ExpiresAt.UTC().Format(time.RFC3339),
	})
}

// handleWisp négocie le WebSocket après contrôle Origin + token, puis exécute
// la session WISP V1. Le token transite en query string car v86 n'envoie ni
// en-tête ni sous-protocole. Le transport est enregistré auprès de
// l'authentificateur : Revoke/AdminRevoke/expiration/arrêt ferment réellement
// le WebSocket et tous les net.Conn TCP associés.
func (s *Server) handleWisp(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origine non autorisée")
		return
	}
	token := r.URL.Query().Get("token")
	// Contrôle préalable : renvoie un 403 JSON clair (comportement d'API).
	if !s.auth.Verify(token, origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "token de session invalide ou expiré")
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

	// Enregistrement atomique du transport : si la session a été révoquée
	// entre la vérification et l'upgrade, l'attachement échoue et on ferme.
	// Chaque WebSocket reçoit son propre ID de transport : plusieurs connexions
	// peuvent partager le même token sans s'écraser, et le detach normal ne
	// retire que cette connexion-là.
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
