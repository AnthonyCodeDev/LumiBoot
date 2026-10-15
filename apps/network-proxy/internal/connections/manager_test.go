package connections

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func pipeConn(t *testing.T) net.Conn {
	t.Helper()
	a, b := net.Pipe()
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	return a
}

func TestAddRemoveCount(t *testing.T) {
	m := NewManager(4, 2, 0)
	if err := m.Add("s1", 1, "example.com", 80, "93.184.216.34", pipeConn(t)); err != nil {
		t.Fatalf("add: %v", err)
	}
	if m.Count() != 1 || m.SessionCount("s1") != 1 {
		t.Fatal("compteurs incohérents")
	}
	if !m.Exists("s1", 1) {
		t.Fatal("flux introuvable")
	}
	if _, ok := m.Conn("s1", 1); !ok {
		t.Fatal("connexion introuvable")
	}
	m.Remove("s1", 1)
	if m.Count() != 0 || m.Exists("s1", 1) {
		t.Fatal("retrait ineffectif")
	}
	m.Remove("s1", 1) // idempotent
}

func TestGlobalLimit(t *testing.T) {
	m := NewManager(1, 8, 0)
	if err := m.Add("s1", 1, "h", 80, "1.1.1.1", pipeConn(t)); err != nil {
		t.Fatal(err)
	}
	if err := m.Add("s2", 2, "h", 80, "1.1.1.1", pipeConn(t)); !errors.Is(err, ErrGlobalLimit) {
		t.Fatalf("limite globale non appliquée: %v", err)
	}
}

func TestSessionLimit(t *testing.T) {
	m := NewManager(8, 1, 0)
	if err := m.Add("s1", 1, "h", 80, "1.1.1.1", pipeConn(t)); err != nil {
		t.Fatal(err)
	}
	if err := m.Add("s1", 2, "h", 80, "1.1.1.1", pipeConn(t)); !errors.Is(err, ErrSessionLimit) {
		t.Fatalf("limite de session non appliquée: %v", err)
	}
	// Une autre session n'est pas affectée.
	if err := m.Add("s2", 2, "h", 80, "1.1.1.1", pipeConn(t)); err != nil {
		t.Fatalf("autre session bloquée à tort: %v", err)
	}
}

func TestDuplicateID(t *testing.T) {
	m := NewManager(8, 8, 0)
	if err := m.Add("s1", 1, "h", 80, "1.1.1.1", pipeConn(t)); err != nil {
		t.Fatal(err)
	}
	if err := m.Add("s1", 1, "h", 80, "1.1.1.1", pipeConn(t)); err == nil {
		t.Fatal("stream_id dupliqué accepté")
	}
}

func TestBytesAndSnapshot(t *testing.T) {
	m := NewManager(8, 8, 0)
	if err := m.Add("s1", 9, "example.com", 443, "93.184.216.34", pipeConn(t)); err != nil {
		t.Fatal(err)
	}
	m.AddBytesIn("s1", 9, 100)
	m.AddBytesOut("s1", 9, 250)
	snap := m.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("snapshot: %d entrées", len(snap))
	}
	if snap[0].BytesIn != 100 || snap[0].BytesOut != 250 {
		t.Fatalf("compteurs: %+v", snap[0])
	}
	if snap[0].Host != "example.com" || snap[0].Port != 443 {
		t.Fatalf("métadonnées: %+v", snap[0])
	}
}

func TestSweepIdle(t *testing.T) {
	m := NewManager(8, 8, 0)
	if err := m.Add("s1", 1, "h", 80, "1.1.1.1", pipeConn(t)); err != nil {
		t.Fatal(err)
	}
	// Timeout négatif : tout est considéré inactif (déterministe, sans sleep).
	if n := m.SweepIdle(-time.Second); n != 1 {
		t.Fatalf("balayage: %d fermés", n)
	}
	if m.Count() != 0 {
		t.Fatal("flux inactif toujours suivi")
	}
	// Rien d'inactif avec un long timeout.
	if err := m.Add("s1", 2, "h", 80, "1.1.1.1", pipeConn(t)); err != nil {
		t.Fatal(err)
	}
	if n := m.SweepIdle(time.Hour); n != 0 {
		t.Fatalf("flux actif balayé à tort: %d", n)
	}
}

func TestSetConn(t *testing.T) {
	m := NewManager(8, 8, 0)
	if err := m.Add("s1", 1, "h", 80, "", nil); err != nil {
		t.Fatal(err)
	}
	if !m.SetConn("s1", 1, pipeConn(t)) {
		t.Fatal("SetConn refusé")
	}
	if m.SetConn("s1", 42, pipeConn(t)) {
		t.Fatal("SetConn accepté pour un flux inconnu")
	}
}

func TestThrottleDisabled(t *testing.T) {
	m := NewManager(8, 8, 0)
	start := time.Now()
	m.Throttle(context.Background(), 1<<20)
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("limiteur désactivé mais lent")
	}
}

func TestThrottleCancellable(t *testing.T) {
	// 1 octet/s : un transfert de 1 Mio devrait attendre très longtemps.
	m := NewManager(8, 8, 1)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	m.Throttle(ctx, 1<<20)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("Throttle non annulable: %v", elapsed)
	}
}
