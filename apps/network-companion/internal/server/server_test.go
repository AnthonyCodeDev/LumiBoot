package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-companion/internal/config"
)

const testOrigin = "http://localhost:5200"

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	cfg := config.Default()
	cfg.AllowedOrigins = []string{testOrigin}
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

func TestAdminProtection(t *testing.T) {
	s, ts := newTestServer(t)
	if resp, err := http.Get(ts.URL + "/"); err != nil {
		t.Fatal(err)
	} else {
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("admin sans token: %d", resp.StatusCode)
		}
	}
	resp, err := http.Get(ts.URL + "/?admin=" + s.AdminToken())
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("admin avec token: %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("type de contenu: %s", ct)
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

	// Approbation admin.
	approve, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/approve",
		strings.NewReader(`{"pairingId":"`+created.PairingID+`"}`))
	approve.Header.Set("Content-Type", "application/json")
	approve.Header.Set("X-Admin-Token", s.AdminToken())
	resp, err = client.Do(approve)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("approbation: %d", resp.StatusCode)
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

func TestPairDeny(t *testing.T) {
	s, ts := newTestServer(t)
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
	deny, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/deny",
		bytes.NewBufferString(`{"pairingId":"`+created.PairingID+`"}`))
	deny.Header.Set("Content-Type", "application/json")
	deny.Header.Set("X-Admin-Token", s.AdminToken())
	resp, err = client.Do(deny)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("refus: %d", resp.StatusCode)
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
