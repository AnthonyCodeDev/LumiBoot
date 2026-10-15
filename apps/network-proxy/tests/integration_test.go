// Test d'intégration : session WISP V1 complète contre un vrai serveur TCP
// d'écho local, en passant par tout le cycle HTTP (appairage -> approbation
// console -> échange -> WebSocket authentifié).
package proxy_test

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lumiboot/network-proxy/internal/config"
	"github.com/lumiboot/network-proxy/internal/server"
	"github.com/lumiboot/network-proxy/internal/wisp"
)

const itOrigin = "http://localhost:5200"

// echoServer démarre un serveur TCP d'écho sur loopback.
func echoServer(t *testing.T) (host string, port int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("écho: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer func() { _ = c.Close() }()
				_, _ = io.Copy(c, c)
			}()
		}
	}()
	addr := ln.Addr().(*net.TCPAddr)
	return "127.0.0.1", addr.Port
}

// proxyFixture monte le proxy réseau local derrière httptest.
func proxyFixture(t *testing.T, mutate func(*config.Config)) (*server.Server, *httptest.Server) {
	t.Helper()
	cfg := config.Default()
	cfg.AllowedOrigins = []string{itOrigin}
	cfg.AllowPrivateNetworks = true // pour joindre l'écho local ; métadonnées toujours bloquées
	if mutate != nil {
		mutate(&cfg)
	}
	srv, err := server.New(cfg)
	if err != nil {
		t.Fatalf("serveur: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

// pairEffectue le cycle complet et renvoie le token de session.
func pair(t *testing.T, srv *server.Server, ts *httptest.Server) string {
	t.Helper()
	client := ts.Client()

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/request", nil)
	req.Header.Set("Origin", itOrigin)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var created struct {
		PairingID string `json:"pairingId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		_ = resp.Body.Close()
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("pair/request: %d", resp.StatusCode)
	}

	// Approbation depuis la console (appel direct à l'authentificateur).
	if err := srv.Authenticator().Approve(created.PairingID, true); err != nil {
		t.Fatalf("pair/approve: %v", err)
	}

	exchange, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/pair/exchange",
		strings.NewReader(`{"pairingId":"`+created.PairingID+`"}`))
	exchange.Header.Set("Origin", itOrigin)
	exchange.Header.Set("Content-Type", "application/json")
	resp, err = client.Do(exchange)
	if err != nil {
		t.Fatal(err)
	}
	var exchanged struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&exchanged); err != nil {
		_ = resp.Body.Close()
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if exchanged.Token == "" {
		t.Fatal("token vide")
	}
	return exchanged.Token
}

func dialWISP(t *testing.T, ts *httptest.Server, token, origin string) *websocket.Conn {
	t.Helper()
	wsURL := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/wisp/?token=" + token
	header := http.Header{}
	if origin != "" {
		header.Set("Origin", origin)
	}
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		if resp != nil {
			_ = resp.Body.Close()
		}
		t.Fatalf("dial WISP: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func readWISP(t *testing.T, conn *websocket.Conn) wisp.Frame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("lecture WISP: %v", err)
	}
	f, err := wisp.DecodeFrame(msg, 4*1024*1024)
	if err != nil {
		t.Fatalf("décodage: %v", err)
	}
	return f
}

func sendWISP(t *testing.T, conn *websocket.Conn, f wisp.Frame) {
	t.Helper()
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteMessage(websocket.BinaryMessage, f.Encode()); err != nil {
		t.Fatalf("écriture WISP: %v", err)
	}
}

func TestFullSession(t *testing.T) {
	srv, ts := proxyFixture(t, nil)
	token := pair(t, srv, ts)
	echoHost, echoPort := echoServer(t)

	conn := dialWISP(t, ts, token, itOrigin)

	// 1. CONTINUE initial de stream 0 (obligatoire pour v86).
	first := readWISP(t, conn)
	if first.Type != wisp.TypeContinue || first.StreamID != 0 {
		t.Fatalf("CONTINUE initial attendu, obtenu type=%#x flux=%d", first.Type, first.StreamID)
	}
	if n, _ := wisp.ParseContinue(first.Payload); n == 0 {
		t.Fatal("fenêtre initiale nulle")
	}

	// 2. CONNECT -> DATA -> CLOSE aller-retour contre l'écho local.
	connect := wisp.Frame{
		Type:     wisp.TypeConnect,
		StreamID: 1,
		Payload:  wisp.BuildConnectPayload(wisp.StreamTypeTCP, uint16(echoPort), echoHost),
	}
	sendWISP(t, conn, connect)
	sendWISP(t, conn, wisp.Frame{Type: wisp.TypeData, StreamID: 1, Payload: []byte("bonjour-echo")})
	echo := readWISP(t, conn)
	if echo.Type != wisp.TypeData || echo.StreamID != 1 || string(echo.Payload) != "bonjour-echo" {
		t.Fatalf("écho inattendu: %+v", echo)
	}

	// 3. Destination bloquée (métadonnées) -> CLOSE 0x48.
	sendWISP(t, conn, wisp.Frame{
		Type:     wisp.TypeConnect,
		StreamID: 2,
		Payload:  wisp.BuildConnectPayload(wisp.StreamTypeTCP, 80, "169.254.169.254"),
	})
	blocked := readWISP(t, conn)
	if blocked.Type != wisp.TypeClose || blocked.StreamID != 2 {
		t.Fatalf("CLOSE attendu, obtenu: %+v", blocked)
	}
	if reason, _ := wisp.ParseClose(blocked.Payload); reason != 0x48 {
		t.Fatalf("raison attendue 0x48, obtenue %#x", reason)
	}

	// 4. Fermeture propre du flux 1.
	sendWISP(t, conn, wisp.Frame{Type: wisp.TypeClose, StreamID: 1, Payload: []byte{wisp.CloseClientDone}})
}

func TestWispRejectsBadOriginAndMissingToken(t *testing.T) {
	srv, ts := proxyFixture(t, nil)
	token := pair(t, srv, ts)
	wsBase := "ws://" + strings.TrimPrefix(ts.URL, "http://") + "/wisp/?token="

	// Origine non autorisée.
	header := http.Header{"Origin": []string{"http://evil.com"}}
	if c, resp, err := websocket.DefaultDialer.Dial(wsBase+token, header); err == nil {
		_ = c.Close()
		t.Fatal("origine hostile acceptée")
	} else if resp != nil {
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("statut origine hostile: %d", resp.StatusCode)
		}
	}

	// Token manquant.
	header = http.Header{"Origin": []string{itOrigin}}
	if c, resp, err := websocket.DefaultDialer.Dial(wsBase, header); err == nil {
		_ = c.Close()
		t.Fatal("token manquant accepté")
	} else if resp != nil {
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("statut token manquant: %d", resp.StatusCode)
		}
	}

	// Compteur d'auth rejetée incrémenté.
	if got := srv.Stats().Snapshot().RejectedAuth; got < 2 {
		t.Fatalf("rejectedAuth=%d, attendu >= 2", got)
	}
}

func TestConnectionLimit(t *testing.T) {
	srv, ts := proxyFixture(t, func(c *config.Config) {
		c.MaxConnectionsPerSession = 1
	})
	token := pair(t, srv, ts)
	echoHost, echoPort := echoServer(t)
	conn := dialWISP(t, ts, token, itOrigin)
	_ = readWISP(t, conn) // CONTINUE initial

	mkConnect := func(id uint32) wisp.Frame {
		return wisp.Frame{
			Type:     wisp.TypeConnect,
			StreamID: id,
			Payload:  wisp.BuildConnectPayload(wisp.StreamTypeTCP, uint16(echoPort), echoHost),
		}
	}
	sendWISP(t, conn, mkConnect(1))
	sendWISP(t, conn, mkConnect(2))
	limited := readWISP(t, conn)
	if limited.Type != wisp.TypeClose || limited.StreamID != 2 {
		t.Fatalf("CLOSE 0x49 attendu sur flux 2, obtenu: %+v", limited)
	}
	if reason, _ := wisp.ParseClose(limited.Payload); reason != 0x49 {
		t.Fatalf("raison attendue 0x49, obtenue %#x", reason)
	}
	// Le premier flux reste fonctionnel.
	sendWISP(t, conn, wisp.Frame{Type: wisp.TypeData, StreamID: 1, Payload: []byte("toujours-la")})
	echo := readWISP(t, conn)
	if echo.Type != wisp.TypeData || string(echo.Payload) != "toujours-la" {
		t.Fatalf("flux 1 cassé: %+v", echo)
	}
}
