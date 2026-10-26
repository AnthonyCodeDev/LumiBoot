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
	// Tests on loopback: local pairing explicitly allowed.
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
		t.Fatalf("JSON decoding: %v", err)
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
		t.Fatalf("health: %+v (%d)", body, resp.StatusCode)
	}
	if body.WispVersion != 1 || body.Version == "" {
		t.Fatalf("version: %+v", body)
	}
}

func TestCORS(t *testing.T) {
	_, ts := newTestServer(t)
	// Allowed preflight.
	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", testOrigin)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("allowed preflight: %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Fatalf("CORS: %q", got)
	}
	// Hostile preflight refused, never "*".
	req, _ = http.NewRequest(http.MethodOptions, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", "http://evil.com")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("hostile preflight: %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got == "*" {
		t.Fatal("CORS '*' forbidden")
	}
}

func TestPairingAPI(t *testing.T) {
	s, ts := newTestServer(t)
	client := ts.Client()

	// Request from an allowed origin (via Origin).
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
		t.Fatalf("creation: %+v (%d)", created, resp.StatusCode)
	}

	// Hostile request refused.
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", "http://evil.com")
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("hostile origin: %d", resp.StatusCode)
	}

	// Exchange before approval: refused.
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
		t.Fatalf("pre-approval exchange: %d", resp.StatusCode)
	}

	// Approval from the console (direct call to the authenticator).
	if err := s.Authenticator().Approve(created.PairingID, true); err != nil {
		t.Fatalf("approval: %v", err)
	}

	// Exchange: token issued only once.
	resp = exchange()
	var exchanged struct {
		Token string `json:"token"`
	}
	decodeJSON(t, resp, &exchanged)
	if resp.StatusCode != http.StatusOK || exchanged.Token == "" {
		t.Fatalf("exchange: %+v (%d)", exchanged, resp.StatusCode)
	}
	resp = exchange()
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("pairing reuse: %d", resp.StatusCode)
	}

	// Self-revocation.
	revoke, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/session/revoke",
		strings.NewReader(`{"token":"`+exchanged.Token+`"}`))
	revoke.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(revoke)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("revocation: %d", resp.StatusCode)
	}
}

// obtainToken runs pairing + approval + exchange and returns the token.
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
		t.Fatalf("approval: %v", err)
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
		t.Fatal("empty token")
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

	// Valid token -> 200 {"ok":true,"expiresAt":...}.
	resp := get(token, testOrigin)
	var body struct {
		Ok        bool   `json:"ok"`
		ExpiresAt string `json:"expiresAt"`
	}
	decodeJSON(t, resp, &body)
	if resp.StatusCode != http.StatusOK || !body.Ok || body.ExpiresAt == "" {
		t.Fatalf("valid verify: %+v (%d)", body, resp.StatusCode)
	}

	// Invalid token -> 401.
	resp = get("DeliberatelyWrong", testOrigin)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid token verify: %d", resp.StatusCode)
	}

	// Missing token -> 401.
	resp = get("", testOrigin)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing token verify: %d", resp.StatusCode)
	}

	// Disallowed origin -> 403.
	resp = get(token, "http://evil.com")
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("hostile origin verify: %d", resp.StatusCode)
	}
}

func TestWispAuthGate(t *testing.T) {
	_, ts := newTestServer(t)
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/wisp/?token=DeliberatelyWrong"
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	header := http.Header{"Origin": []string{testOrigin}}
	if _, resp, err := dialer.Dial(wsURL, header); err == nil {
		t.Fatal("invalid token accepted")
	} else if resp != nil && resp.StatusCode != http.StatusForbidden {
		_ = resp.Body.Close()
		t.Fatalf("unexpected status: %d", resp.StatusCode)
	}

	// Hostile origin, even without a token.
	header = http.Header{"Origin": []string{"http://evil.com"}}
	if _, resp, err := dialer.Dial(wsURL, header); err == nil {
		t.Fatal("hostile origin accepted")
	} else if resp != nil && resp.StatusCode != http.StatusForbidden {
		_ = resp.Body.Close()
		t.Fatalf("unexpected status: %d", resp.StatusCode)
	}
}
