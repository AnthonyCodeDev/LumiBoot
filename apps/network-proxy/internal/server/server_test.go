package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-proxy/internal/auth"
	"github.com/lumiboot/network-proxy/internal/config"
	"github.com/lumiboot/network-proxy/internal/testutil"
)

// testOrigin is the deployment origin the tests allow and send, derived from
// `E2E_HOST` / `E2E_PORT` (`http://127.0.0.1:5200` by default).
var testOrigin = testutil.TestOrigin()

// otherOrigin is a second allowed origin, for cross-origin isolation tests.
var otherOrigin = testutil.AltOrigin()

func TestRedactingWriter(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{
			// The whole match, key included, is rewritten as "token=REDACTED":
			// the redaction is byte-safe but normalises the key's case in the
			// log line, which is cosmetic.
			name:  "mixed case and several occurrences",
			input: "GET /wisp?token=first&x=1&ToKeN=second HTTP/1.1\n",
			want:  "GET /wisp?token=REDACTED&x=1&token=REDACTED HTTP/1.1\n",
		},
		{
			name:  "ampersand, space, CRLF and LF terminators",
			input: "token=a token=b&token=c\r\ntoken=d\n",
			want:  "token=REDACTED token=REDACTED&token=REDACTED\r\ntoken=REDACTED\n",
		},
		{
			name:  "empty value",
			input: "GET /wisp?token= HTTP/1.1\n",
			want:  "GET /wisp?token=REDACTED HTTP/1.1\n",
		},
		{
			// Case-folding a non-ASCII rune may change its byte length, so
			// offset arithmetic on a lowered copy would cut inside the prefix.
			// The byte-wise regexp must keep the prefix intact and drop the
			// secret.
			name:  "non-ASCII prefix",
			input: "é token=secret",
			want:  "é token=REDACTED",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			input := []byte(tc.input)
			n, err := (redactingWriter{&output}).Write(input)
			if err != nil || n != len(input) {
				t.Fatalf("write: n=%d err=%v", n, err)
			}
			if got := output.String(); got != tc.want {
				t.Fatalf("redacted output = %q, want %q", got, tc.want)
			}
			if strings.Contains(output.String(), "secret") ||
				strings.Contains(output.String(), "first") ||
				strings.Contains(output.String(), "second") {
				t.Fatalf("secret leaked: %q", output.String())
			}
			if !utf8.ValidString(output.String()) {
				t.Fatalf("invalid UTF-8 output: %q", output.String())
			}
		})
	}
}

// errorWriter always fails; shortWriter accepts everything but the last byte.
type errorWriter struct{ err error }

func (w errorWriter) Write([]byte) (int, error) { return 0, w.err }

type shortWriter struct{}

func (shortWriter) Write(p []byte) (int, error) { return len(p) - 1, nil }

func TestRedactingWriterContract(t *testing.T) {
	sentinel := errors.New("write failed")
	if n, err := (redactingWriter{errorWriter{sentinel}}).Write([]byte("token=x")); n != 0 || !errors.Is(err, sentinel) {
		t.Fatalf("write error: n=%d err=%v", n, err)
	}
	if n, err := (redactingWriter{shortWriter{}}).Write([]byte("token=x")); n != 0 || !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("short write: n=%d err=%v", n, err)
	}
}

func TestDecodeBodyRejectsTrailingData(t *testing.T) {
	for _, body := range []string{
		`{"token":"valid"}{"token":"other"}`,
		`{"token":"valid"} trailing`,
	} {
		t.Run(body, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/session/revoke", strings.NewReader(body))
			recorder := httptest.NewRecorder()
			var payload struct {
				Token string `json:"token"`
			}
			if decodeBody(recorder, req, &payload) {
				t.Fatal("accepted trailing data")
			}
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d", recorder.Code)
			}
		})
	}
}

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	return newTestServerWithOrigins(t, testOrigin)
}

func newTestServerWithOrigins(t *testing.T, origins ...string) (*Server, *httptest.Server) {
	t.Helper()
	cfg := config.Default()
	cfg.AllowedOrigins = origins
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
	// Hostile preflight refused, never a wildcard.
	req, _ = http.NewRequest(http.MethodOptions, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", testutil.HostileOrigin())
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

	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", testutil.HostileOrigin())
	resp, err = client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("hostile origin: %d", resp.StatusCode)
	}

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

	if err := s.Authenticator().Approve(created.PairingID, true); err != nil {
		t.Fatalf("approval: %v", err)
	}

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

	revoke, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/session/revoke",
		strings.NewReader(`{"token":"`+exchanged.Token+`"}`))
	revoke.Header.Set("Origin", testOrigin)
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

	resp := get(token, testOrigin)
	var body struct {
		Ok        bool   `json:"ok"`
		ExpiresAt string `json:"expiresAt"`
	}
	decodeJSON(t, resp, &body)
	if resp.StatusCode != http.StatusOK || !body.Ok || body.ExpiresAt == "" {
		t.Fatalf("valid verify: %+v (%d)", body, resp.StatusCode)
	}

	resp = get("DeliberatelyWrong", testOrigin)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid token verify: %d", resp.StatusCode)
	}

	resp = get("", testOrigin)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing token verify: %d", resp.StatusCode)
	}

	resp = get(token, testutil.HostileOrigin())
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("hostile origin verify: %d", resp.StatusCode)
	}
}

func TestWispAuthGate(t *testing.T) {
	_, ts := newTestServer(t)
	wsURL := testutil.WispURL(ts, "DeliberatelyWrong")
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	header := http.Header{"Origin": []string{testOrigin}}
	if _, resp, err := dialer.Dial(wsURL, header); err == nil {
		t.Fatal("invalid token accepted")
	} else if resp != nil && resp.StatusCode != http.StatusForbidden {
		_ = resp.Body.Close()
		t.Fatalf("unexpected status: %d", resp.StatusCode)
	}

	header = http.Header{"Origin": []string{testutil.HostileOrigin()}}
	if _, resp, err := dialer.Dial(wsURL, header); err == nil {
		t.Fatal("hostile origin accepted")
	} else if resp != nil && resp.StatusCode != http.StatusForbidden {
		_ = resp.Body.Close()
		t.Fatalf("unexpected status: %d", resp.StatusCode)
	}
}

// TestServerTimeoutConfig guards the HTTP server deadlines: a missing read or
// write timeout leaves slow clients free to hold resources forever.
func TestServerTimeoutConfig(t *testing.T) {
	s, _ := newTestServer(t)
	srv := s.httpSrv
	if srv == nil {
		t.Fatal("http server not built")
	}
	if srv.ReadHeaderTimeout != readHeaderTimeout || srv.ReadHeaderTimeout == 0 {
		t.Fatalf("ReadHeaderTimeout = %v", srv.ReadHeaderTimeout)
	}
	if srv.ReadTimeout != 15*time.Second {
		t.Fatalf("ReadTimeout = %v, want 15s", srv.ReadTimeout)
	}
	if srv.WriteTimeout != 30*time.Second {
		t.Fatalf("WriteTimeout = %v, want 30s", srv.WriteTimeout)
	}
	if srv.IdleTimeout != 120*time.Second {
		t.Fatalf("IdleTimeout = %v, want 120s", srv.IdleTimeout)
	}
	if srv.MaxHeaderBytes != 16<<10 {
		t.Fatalf("MaxHeaderBytes = %d, want %d", srv.MaxHeaderBytes, 16<<10)
	}
}

// TestSecurityHeaders: the proxy only serves JSON and WebSocket upgrades, so the
// policy must not allow any resource to load.
func TestSecurityHeaders(t *testing.T) {
	_, ts := newTestServer(t)
	resp, err := http.Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	want := map[string]string{
		"Content-Security-Policy":      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Permissions-Policy":           "camera=(), microphone=(), geolocation=()",
		"X-Content-Type-Options":       "nosniff",
		"X-Frame-Options":              "DENY",
		"Referrer-Policy":              "no-referrer",
	}
	for name, value := range want {
		if got := resp.Header.Get(name); got != value {
			t.Errorf("%s = %q, want %q", name, got, value)
		}
	}
	// Deliberately absent: loopback traffic is plain HTTP.
	if got := resp.Header.Get("Strict-Transport-Security"); got != "" {
		t.Fatalf("Strict-Transport-Security = %q, want none", got)
	}
}

// TestTokenExchangeNotCached: a response carrying a session token must not be
// stored by a browser or an intermediary cache.
func TestTokenExchangeNotCached(t *testing.T) {
	s, ts := newTestServer(t)
	p, err := s.Authenticator().RequestPairing(testOrigin)
	if err != nil {
		t.Fatalf("pairing: %v", err)
	}
	if err := s.Authenticator().Approve(p.ID, true); err != nil {
		t.Fatalf("approval: %v", err)
	}
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/exchange",
		strings.NewReader(`{"pairingId":"`+p.ID+`"}`))
	req.Header.Set("Origin", testOrigin)
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		Token string `json:"token"`
	}
	decodeJSON(t, resp, &body)
	if resp.StatusCode != http.StatusOK || body.Token == "" {
		t.Fatalf("exchange: %+v (%d)", body, resp.StatusCode)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := resp.Header.Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma = %q, want no-cache", got)
	}
}

// TestPairingStatusOriginScoped: a pairing is readable only from the origin that
// requested it, even when another origin is allowed.
func TestPairingStatusOriginScoped(t *testing.T) {
	_, ts := newTestServerWithOrigins(t, testOrigin, otherOrigin)
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
	if resp.StatusCode != http.StatusCreated || created.PairingID == "" {
		t.Fatalf("creation: %+v (%d)", created, resp.StatusCode)
	}

	status := func(origin string) *http.Response {
		r, _ := http.NewRequest(http.MethodGet,
			ts.URL+"/api/pair/status?id="+created.PairingID, nil)
		r.Header.Set("Origin", origin)
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	resp = status(testOrigin)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("same-origin status: %d", resp.StatusCode)
	}
	resp = status(otherOrigin)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("other allowed origin read the pairing: %d", resp.StatusCode)
	}
}

// TestPairRequestBodyOriginIgnored: the JSON body no longer carries the origin.
func TestPairRequestBodyOriginIgnored(t *testing.T) {
	s, ts := newTestServerWithOrigins(t, testOrigin, otherOrigin)
	client := ts.Client()

	post := func(originHeader, body string) *http.Response {
		r, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/request", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if originHeader != "" {
			r.Header.Set("Origin", originHeader)
		}
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	// No Origin header: the body field is ignored and the request is refused.
	resp := post("", `{"origin":"`+testOrigin+`"}`)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("body-only origin: %d, want 400", resp.StatusCode)
	}
	if got := len(s.Authenticator().PendingPairings()); got != 0 {
		t.Fatalf("pairing created from a body origin: %d pending", got)
	}

	// A body origin cannot override the header: the pairing stays bound to the
	// header origin.
	resp = post(testOrigin, `{"origin":"`+otherOrigin+`"}`)
	var created struct {
		PairingID string `json:"pairingId"`
	}
	decodeJSON(t, resp, &created)
	if resp.StatusCode != http.StatusCreated || created.PairingID == "" {
		t.Fatalf("creation: %+v (%d)", created, resp.StatusCode)
	}
	if _, ok := s.Authenticator().StatusFor(created.PairingID, testOrigin); !ok {
		t.Fatal("pairing is not bound to the header origin")
	}
	if _, ok := s.Authenticator().StatusFor(created.PairingID, otherOrigin); ok {
		t.Fatal("body origin overrode the header origin")
	}
}

// TestSessionRevokeRequiresAllowedOrigin: the revoke route uses the same origin
// gate as the other sensitive routes.
func TestSessionRevokeRequiresAllowedOrigin(t *testing.T) {
	s, ts := newTestServer(t)
	token := obtainToken(t, s, ts)
	client := ts.Client()

	post := func(origin string) *http.Response {
		r, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/session/revoke",
			strings.NewReader(`{"token":"`+token+`"}`))
		r.Header.Set("Content-Type", "application/json")
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		resp, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	for _, origin := range []string{"", testutil.HostileOrigin()} {
		resp := post(origin)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("revoke with origin %q: %d, want 403", origin, resp.StatusCode)
		}
	}
	if !s.Authenticator().Verify(token, testOrigin) {
		t.Fatal("token revoked without an allowed origin")
	}

	resp := post(testOrigin)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("allowed revoke: %d", resp.StatusCode)
	}
	if s.Authenticator().Verify(token, testOrigin) {
		t.Fatal("token still valid after an allowed revocation")
	}
}

// TestWispTransportLimit: the fifth simultaneous WebSocket on one token is
// refused before the upgrade with an explicit JSON error; closing one frees a
// slot.
func TestWispTransportLimit(t *testing.T) {
	s, ts := newTestServer(t)
	token := obtainToken(t, s, ts)
	wsURL := testutil.WispURL(ts, token)
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	header := http.Header{"Origin": []string{testOrigin}}

	conns := make([]*websocket.Conn, 0, auth.MaxTransportsPerToken)
	for i := 0; i < auth.MaxTransportsPerToken; i++ {
		conn, resp, err := dialer.Dial(wsURL, header)
		if err != nil {
			if resp != nil {
				_ = resp.Body.Close()
			}
			t.Fatalf("connection %d: %v", i, err)
		}
		conns = append(conns, conn)
		t.Cleanup(func() { _ = conn.Close() })
	}

	conn, resp, err := dialer.Dial(wsURL, header)
	if err == nil {
		_ = conn.Close()
		t.Fatal("connection above the cap accepted")
	}
	if resp == nil {
		t.Fatalf("refused upgrade without an HTTP response: %v", err)
	}
	var refused struct {
		Error string `json:"error"`
	}
	decodeJSON(t, resp, &refused)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("cap status: %d, want 429", resp.StatusCode)
	}
	if refused.Error != "too many active connections for this session" {
		t.Fatalf("cap message: %q", refused.Error)
	}

	// Closing a transport frees its slot once the handler has detached.
	_ = conns[0].Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		conn, resp, err := dialer.Dial(wsURL, header)
		if err == nil {
			_ = conn.Close()
			return
		}
		if resp != nil {
			_ = resp.Body.Close()
		}
		if time.Now().After(deadline) {
			t.Fatalf("slot not released after closing a transport: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
