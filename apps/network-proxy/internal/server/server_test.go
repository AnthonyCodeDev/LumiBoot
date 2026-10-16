package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-proxy/internal/config"
)

const testOrigin = "http://localhost:5200"

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	cfg := config.Default()
	cfg.AllowedOrigins = []string{testOrigin}
	// Tests sur loopback : appairage local explicitement autorisé.
	cfg.AllowLocalOrigins = true
	s, err := New(cfg)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts
}

func decodeJSON(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("décodage JSON: %v", err)
	}
}

func TestHealth(t *testing.T) {
	_, ts := newTestServer(t)
	resp, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Status            string `json:"status"`
		Version           string `json:"version"`
		WispVersion       int    `json:"wispVersion"`
		ActiveConnections uint64 `json:"activeConnections"`
	}
	decodeJSON(t, resp, &body)
	if resp.StatusCode != http.StatusOK || body.Status != "ok" {
		t.Fatalf("santé: %+v (%d)", body, resp.StatusCode)
	}
	if body.WispVersion != 1 || body.Version == "" {
		t.Fatalf("version: %+v", body)
	}
}

func TestCORS(t *testing.T) {
	_, ts := newTestServer(t)
	// Préflight autorisé.
	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", testOrigin)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("préflight autorisé: %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Fatalf("CORS: %q", got)
	}
	// Préflight hostile refusé, jamais "*".
	req, _ = http.NewRequest(http.MethodOptions, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", "http://evil.com")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("préflight hostile: %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got == "*" {
		t.Fatal("CORS '*' interdit")
	}
}

func TestPairingAPI(t *testing.T) {
	s, ts := newTestServer(t)
	client := ts.Client()

	// Demande depuis une origine autorisée (via Origin).
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", testOrigin)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		PairingID string `json:"pairingId"`
		UserCode  string `json:"userCode"`
		ExpiresAt string `json:"expiresAt"`
	}
	decodeJSON(t, resp, &created)
	if resp.StatusCode != http.StatusCreated || created.PairingID == "" || created.UserCode == "" {
		t.Fatalf("création: %+v (%d)", created, resp.StatusCode)
	}

	// Demande hostile refusée.
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", "http://evil.com")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("origine hostile: %d", resp.StatusCode)
	}

	// Échange avant approbation : refusé.
	exchange := func() *http.Response {
		r, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/exchange",
			strings.NewReader(`{"pairingId":"`+created.PairingID+`"}`))
		r.Header.Set("Origin", testOrigin)
		r.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	resp = exchange()
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("échange pré-approbation: %d", resp.StatusCode)
	}

	// Approbation depuis la console (appel direct à l'authentificateur).
	if err := s.Authenticator().Approve(created.PairingID, true); err != nil {
		t.Fatalf("approbation: %v", err)
	}

	// Échange : token émis une seule fois.
	resp = exchange()
	var exchanged struct {
		Token string `json:"token"`
	}
	decodeJSON(t, resp, &exchanged)
	if resp.StatusCode != http.StatusOK || exchanged.Token == "" {
		t.Fatalf("échange: %+v (%d)", exchanged, resp.StatusCode)
	}
	resp = exchange()
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("réutilisation d'appairage: %d", resp.StatusCode)
	}

	// Auto-révocation.
	revoke, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/session/revoke",
		strings.NewReader(`{"token":"`+exchanged.Token+`"}`))
	revoke.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(revoke)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("révocation: %d", resp.StatusCode)
	}
}

// obtainToken exécute appairage + approbation + échange et renvoie le token.
func obtainToken(t *testing.T, s *Server, ts *httptest.Server) string {
	t.Helper()
	client := ts.Client()
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", testOrigin)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		PairingID string `json:"pairingId"`
	}
	decodeJSON(t, resp, &created)
	if err := s.Authenticator().Approve(created.PairingID, true); err != nil {
		t.Fatalf("approbation: %v", err)
	}
	ex, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/exchange",
		strings.NewReader(`{"pairingId":"`+created.PairingID+`"}`))
	ex.Header.Set("Origin", testOrigin)
	ex.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(ex)
	if err != nil {
		t.Fatal(err)
	}
	var exchanged struct {
		Token string `json:"token"`
	}
	decodeJSON(t, resp, &exchanged)
	if exchanged.Token == "" {
		t.Fatal("token vide")
	}
	return exchanged.Token
}

func TestSessionVerify(t *testing.T) {
	s, ts := newTestServer(t)
	client := ts.Client()
	token := obtainToken(t, s, ts)

	get := func(token, origin string) *http.Response {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/session/verify?token="+token, nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	// Token valide -> 200 {"ok":true,"expiresAt":...}.
	resp := get(token, testOrigin)
	var body struct {
		Ok        bool   `json:"ok"`
		ExpiresAt string `json:"expiresAt"`
	}
	decodeJSON(t, resp, &body)
	if resp.StatusCode != http.StatusOK || !body.Ok || body.ExpiresAt == "" {
		t.Fatalf("verify valide: %+v (%d)", body, resp.StatusCode)
	}

	// Token invalide -> 401.
	resp = get("DeliberementFaux", testOrigin)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("verify token invalide: %d", resp.StatusCode)
	}

	// Token absent -> 401.
	resp = get("", testOrigin)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("verify token absent: %d", resp.StatusCode)
	}

	// Origine non autorisée -> 403.
	resp = get(token, "http://evil.com")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("verify origine hostile: %d", resp.StatusCode)
	}
}

func TestWispAuthGate(t *testing.T) {
	_, ts := newTestServer(t)
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/wisp/?token=DeliberementFaux"
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	header := http.Header{"Origin": []string{testOrigin}}
	if _, resp, err := dialer.Dial(wsURL, header); err == nil {
		t.Fatal("token invalide accepté")
	} else if resp != nil && resp.StatusCode != http.StatusForbidden {
		_ = resp.Body.Close()
		t.Fatalf("statut inattendu: %d", resp.StatusCode)
	}

	// Origine hostile, même sans token.
	header = http.Header{"Origin": []string{"http://evil.com"}}
	if _, resp, err := dialer.Dial(wsURL, header); err == nil {
		t.Fatal("origine hostile acceptée")
	} else if resp != nil && resp.StatusCode != http.StatusForbidden {
		_ = resp.Body.Close()
		t.Fatalf("statut inattendu: %d", resp.StatusCode)
	}
}
