// Package server expose le compagnon : endpoints HTTP d'appairage et de santé,
// page d'administration locale, et point d'accès WebSocket WISP.
// Écoute STRICTEMENT loopback (validé par config). Arrêt gracieux via contexte.
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-companion/internal/auth"
	"github.com/lumiboot/network-companion/internal/config"
	"github.com/lumiboot/network-companion/internal/connections"
	"github.com/lumiboot/network-companion/internal/diagnostics"
	"github.com/lumiboot/network-companion/internal/wisp"
)

// Version est surchargeable à la compilation (-ldflags "-X ...Version=...").
var Version = "0.1.0-dev"

// WispVersion annonce le protocole supporté (V1 uniquement).
const WispVersion = 1

// maxBody borne les corps de requêtes JSON (64 Kio).
const maxBody = 64 * 1024

// Server est le serveur du compagnon.
type Server struct {
	cfg        config.Config
	auth       *auth.Authenticator
	manager    *connections.Manager
	stats      *diagnostics.Counters
	adminToken string
	mux        *http.ServeMux
	upgrader   websocket.Upgrader
	httpSrv    *http.Server
	startTime  time.Time
}

// New valide la configuration et construit le serveur.
func New(cfg config.Config) (*Server, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	token, err := randomToken(16)
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:        cfg,
		auth:       auth.NewAuthenticator(cfg.AllowedOrigins, cfg.PairingTTL.Std(), cfg.SessionTokenTTL.Std()),
		manager:    connections.NewManager(cfg.MaxConnections, cfg.MaxConnectionsPerSession, cfg.BandwidthLimitBytesPerSecond),
		stats:      &diagnostics.Counters{},
		adminToken: token,
		startTime:  time.Now(),
		upgrader: websocket.Upgrader{
			// Origine vérifiée manuellement avant l'upgrade (comptage + 403 JSON).
			CheckOrigin:     func(_ *http.Request) bool { return true },
			ReadBufferSize:  32 * 1024,
			WriteBufferSize: 32 * 1024,
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /", s.handleAdmin)
	mux.HandleFunc("POST /api/pair/request", s.handlePairRequest)
	mux.HandleFunc("GET /api/pair/status", s.handlePairStatus)
	mux.HandleFunc("POST /api/pair/exchange", s.handlePairExchange)
	mux.HandleFunc("POST /api/pair/approve", s.handlePairApprove)
	mux.HandleFunc("POST /api/pair/deny", s.handlePairDeny)
	mux.HandleFunc("GET /api/sessions", s.handleSessions)
	mux.HandleFunc("POST /api/session/revoke", s.handleSessionRevoke)
	mux.HandleFunc("GET /wisp/", s.handleWisp)
	mux.HandleFunc("GET /wisp", s.handleWisp)
	s.mux = mux
	s.httpSrv = &http.Server{
		Handler:           securityHeaders(s.preflightMiddleware(mux)),
		ReadHeaderTimeout: 10 * time.Second,
	}
	return s, nil
}

// AdminToken expose le jeton d'admin (affiché en console au démarrage).
func (s *Server) AdminToken() string { return s.adminToken }

// AdminURL est l'URL complète de la page d'administration.
func (s *Server) AdminURL() string {
	return "http://" + s.cfg.ListenAddr + "/?admin=" + s.adminToken
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
		_ = s.httpSrv.Shutdown(shutCtx)
		<-errCh
		return nil
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
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
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token")
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

// checkAdmin vérifie le jeton d'admin (en-tête X-Admin-Token ou query ?admin=).
func (s *Server) checkAdmin(w http.ResponseWriter, r *http.Request) bool {
	provided := r.Header.Get("X-Admin-Token")
	if provided == "" {
		provided = r.URL.Query().Get("admin")
	}
	if subtle.ConstantTimeCompare([]byte(provided), []byte(s.adminToken)) != 1 {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "jeton d'admin invalide")
		return false
	}
	return true
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

func (s *Server) handleAdmin(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		writeError(w, http.StatusNotFound, "introuvable")
		return
	}
	if !s.checkAdmin(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(adminHTML))
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
	// Statut consulté par la page web (origine autorisée) ou l'admin.
	if r.Header.Get("Origin") != "" {
		if s.requireAllowedOrigin(w, r) == "" {
			return
		}
	} else if r.URL.Query().Get("admin") != "" && !s.checkAdmin(w, r) {
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

func (s *Server) handlePairApprove(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	if !s.checkAdmin(w, r) {
		return
	}
	var body struct {
		PairingID string `json:"pairingId"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if err := s.auth.Approve(body.PairingID, true); err != nil {
		writeError(w, http.StatusNotFound, "appairage introuvable ou expiré")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": auth.StatusApproved})
}

func (s *Server) handlePairDeny(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	if !s.checkAdmin(w, r) {
		return
	}
	var body struct {
		PairingID string `json:"pairingId"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	_ = s.auth.Approve(body.PairingID, false)
	writeJSON(w, http.StatusOK, map[string]string{"status": auth.StatusDenied})
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	if !s.checkAdmin(w, r) {
		return
	}
	sessions := s.auth.ListSessions()
	pending := s.auth.PendingPairings()
	type pendingJSON struct {
		PairingID string `json:"pairingId"`
		UserCode  string `json:"userCode"`
		Origin    string `json:"origin"`
		ExpiresAt string `json:"expiresAt"`
	}
	pj := make([]pendingJSON, 0, len(pending))
	for _, p := range pending {
		pj = append(pj, pendingJSON{
			PairingID: p.ID,
			UserCode:  p.UserCode,
			Origin:    p.Origin,
			ExpiresAt: p.ExpiresAt.UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sessions": sessions,
		"pending":  pj,
		"streams":  s.manager.Snapshot(),
	})
}

func (s *Server) handleSessionRevoke(w http.ResponseWriter, r *http.Request) {
	s.setCORS(w, r)
	var body struct {
		Token string `json:"token"`
		ID    string `json:"id"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	// Auto-révocation par possession du token brut.
	if body.Token != "" && s.auth.Revoke(body.Token) {
		writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
		return
	}
	// Révocation par l'admin local via l'empreinte de session.
	if body.ID != "" && s.checkAdmin(w, r) {
		if s.auth.AdminRevoke(body.ID) {
			writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
			return
		}
	}
	writeError(w, http.StatusNotFound, "session introuvable")
}

// handleWisp négocie le WebSocket après contrôle Origin + token, puis exécute
// la session WISP V1. Le token transite en query string car v86 n'envoie ni
// en-tête ni sous-protocole.
func (s *Server) handleWisp(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if !s.auth.IsOriginAllowed(origin) {
		s.stats.IncRejectedAuth()
		writeError(w, http.StatusForbidden, "origine non autorisée")
		return
	}
	token := r.URL.Query().Get("token")
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
	_ = h.Run(r.Context())
}

func randomToken(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// adminHTML est la page d'administration locale (sombre, sobre).
// Le jeton d'admin est lu dans le query param ?admin= et renvoyé en en-tête.
const adminHTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LumiBoot Network Companion — Admin</title>
<style>
body{background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;margin:0;padding:24px}
main{max-width:720px;margin:auto}
h1{font-size:20px}h2{font-size:16px;margin-top:28px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 16px;margin:8px 0}
button{background:#238636;color:#fff;border:0;border-radius:6px;padding:6px 12px;margin-right:8px;cursor:pointer}
button.deny,button.revoke{background:#da3633}
code{background:#161b22;padding:2px 6px;border-radius:4px}
.muted{color:#8b949e;font-size:13px}
</style>
</head>
<body>
<main>
<h1>LumiBoot Network Companion</h1>
<p class="muted">Santé : <code id="health">…</code></p>
<h2>Demandes d'appairage en attente</h2>
<div id="pending"><p class="muted">Chargement…</p></div>
<h2>Sessions actives</h2>
<div id="sessions"><p class="muted">Chargement…</p></div>
<h2>Flux TCP actifs</h2>
<div id="streams"><p class="muted">Chargement…</p></div>
</main>
<script>
var admin = new URLSearchParams(location.search).get("admin") || "";
function headers() { return {"Content-Type": "application/json", "X-Admin-Token": admin}; }
function refresh() {
  fetch("/api/sessions?admin=" + encodeURIComponent(admin)).then(function(r) { return r.json(); }).then(function(d) {
    var p = document.getElementById("pending");
    p.innerHTML = "";
    if (!d.pending || !d.pending.length) { p.innerHTML = "<p class=muted>Aucune demande.</p>"; }
    (d.pending || []).forEach(function(x) {
      var div = document.createElement("div"); div.className = "card";
      div.innerHTML = "<div>Code <b>" + x.userCode + "</b> — <span class=muted>" + x.origin + "</span></div>";
      var ok = document.createElement("button"); ok.textContent = "Approuver";
      ok.onclick = function() { act("/api/pair/approve", x.pairingId); };
      var no = document.createElement("button"); no.textContent = "Refuser"; no.className = "deny";
      no.onclick = function() { act("/api/pair/deny", x.pairingId); };
      div.appendChild(ok); div.appendChild(no); p.appendChild(div);
    });
    var s = document.getElementById("sessions");
    s.innerHTML = "";
    if (!d.sessions || !d.sessions.length) { s.innerHTML = "<p class=muted>Aucune session.</p>"; }
    (d.sessions || []).forEach(function(x) {
      var div = document.createElement("div"); div.className = "card";
      div.textContent = x.ID + " — " + x.Origin + " (expire " + x.ExpiresAt + ") ";
      var b = document.createElement("button"); b.textContent = "Révoquer"; b.className = "revoke";
      b.onclick = function() { revokeSession(x.ID); };
      div.appendChild(b); s.appendChild(div);
    });
    var t = document.getElementById("streams");
    t.innerHTML = "";
    if (!d.streams || !d.streams.length) { t.innerHTML = "<p class=muted>Aucun flux.</p>"; }
    (d.streams || []).forEach(function(x) {
      var div = document.createElement("div"); div.className = "card";
      div.textContent = x.Host + ":" + x.Port + " (" + x.IP + ") ⇅ " + x.BytesIn + "/" + x.BytesOut + " octets";
      t.appendChild(div);
    });
  });
  fetch("/health").then(function(r) { return r.json(); }).then(function(h) {
    document.getElementById("health").textContent = h.status + " v" + h.version + " — " + h.activeConnections + " actives";
  });
}
function act(url, pairingId) {
  fetch(url + "?admin=" + encodeURIComponent(admin), {method: "POST", headers: headers(), body: JSON.stringify({pairingId: pairingId})}).then(refresh);
}
function revokeSession(id) {
  fetch("/api/session/revoke?admin=" + encodeURIComponent(admin), {method: "POST", headers: headers(), body: JSON.stringify({id: id})}).then(refresh);
}
setInterval(refresh, 3000);
refresh();
</script>
</body>
</html>`
