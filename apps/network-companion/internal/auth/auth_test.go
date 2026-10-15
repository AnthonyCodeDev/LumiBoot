package auth

import (
	"crypto/rand"
	"errors"
	"testing"
	"time"
)

func testAuth(now *time.Time) *Authenticator {
	return NewAuthenticatorWithClock(
		[]string{"http://localhost:5200", "https://lumiboot.app"},
		10*time.Minute,
		time.Hour,
		rand.Reader,
		func() time.Time { return *now },
	)
}

func TestOriginMatching(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	allowed := []string{
		"http://localhost:5200",
		"http://localhost:5200/",            // slash final toléré
		"HTTP://LOCALHOST:5200/some/path",   // casse + chemin tolérés
		"https://lumiboot.app",
	}
	for _, o := range allowed {
		if !a.IsOriginAllowed(o) {
			t.Fatalf("origine autorisée refusée: %s", o)
		}
	}
	denied := []string{
		"", "null", "http://localhost:5201", "http://evil.com",
		"http://localhost:5200.evil.com", "ftp://localhost:5200", "not-a-url",
	}
	for _, o := range denied {
		if a.IsOriginAllowed(o) {
			t.Fatalf("origine interdite acceptée: %q", o)
		}
	}
}

func TestPairingFlow(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)

	p, err := a.RequestPairing("http://localhost:5200")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if p.ID == "" || p.UserCode == "" || p.Status != StatusPending {
		t.Fatalf("appairage incomplet: %+v", p)
	}

	// Échange avant approbation : refusé.
	if _, _, err := a.Exchange(p.ID, "http://localhost:5200"); !errors.Is(err, ErrPairingNotApproved) {
		t.Fatalf("échange pré-approbation: %v", err)
	}

	if err := a.Approve(p.ID, true); err != nil {
		t.Fatalf("approve: %v", err)
	}
	token, expiresAt, err := a.Exchange(p.ID, "http://localhost:5200")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if token == "" || expiresAt.IsZero() {
		t.Fatal("token vide")
	}
	// Usage unique.
	if _, _, err := a.Exchange(p.ID, "http://localhost:5200"); !errors.Is(err, ErrPairingNotFound) {
		t.Fatalf("réutilisation d'appairage: %v", err)
	}

	if !a.Verify(token, "http://localhost:5200") {
		t.Fatal("token valide refusé")
	}
	// Liaison d'origine.
	if a.Verify(token, "https://lumiboot.app") {
		t.Fatal("token accepté depuis une autre origine")
	}
	if a.Verify("", "http://localhost:5200") {
		t.Fatal("token vide accepté")
	}
	if a.Verify("nawak", "http://localhost:5200") {
		t.Fatal("token inconnu accepté")
	}

	if got := len(a.ListSessions()); got != 1 {
		t.Fatalf("sessions: %d", got)
	}
	if !a.Revoke(token) {
		t.Fatal("révocation échouée")
	}
	if a.Verify(token, "http://localhost:5200") {
		t.Fatal("token révoqué accepté")
	}
	if a.Revoke(token) {
		t.Fatal("double révocation acceptée")
	}
}

func TestPairingDenied(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	p, err := a.RequestPairing("http://localhost:5200")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Approve(p.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, ok := a.Status(p.ID); ok {
		t.Fatal("appairage refusé toujours présent")
	}
}

func TestPairingBadOrigin(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	if _, err := a.RequestPairing("http://evil.com"); !errors.Is(err, ErrOriginNotAllowed) {
		t.Fatalf("origine hostile: %v", err)
	}
	p, err := a.RequestPairing("http://localhost:5200")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Approve(p.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.Exchange(p.ID, "https://lumiboot.app"); !errors.Is(err, ErrOriginMismatch) {
		t.Fatalf("origine différente acceptée: %v", err)
	}
}

func TestExpiry(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	p, err := a.RequestPairing("http://localhost:5200")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(11 * time.Minute) // au-delà de PairingTTL
	if _, ok := a.Status(p.ID); ok {
		t.Fatal("appairage expiré toujours présent")
	}
	if err := a.Approve(p.ID, true); !errors.Is(err, ErrPairingNotFound) && !errors.Is(err, ErrPairingExpired) {
		t.Fatalf("approve expiré: %v", err)
	}

	now = time.Now()
	a = testAuth(&now)
	p2, err := a.RequestPairing("http://localhost:5200")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Approve(p2.ID, true); err != nil {
		t.Fatal(err)
	}
	token, _, err := a.Exchange(p2.ID, "http://localhost:5200")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Hour) // au-delà de SessionTokenTTL
	if a.Verify(token, "http://localhost:5200") {
		t.Fatal("session expirée acceptée")
	}
	if got := len(a.ListSessions()); got != 0 {
		t.Fatalf("sessions expirées listées: %d", got)
	}
}

func TestAdminRevoke(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	p, _ := a.RequestPairing("http://localhost:5200")
	_ = a.Approve(p.ID, true)
	token, _, _ := a.Exchange(p.ID, "http://localhost:5200")
	sessions := a.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("sessions: %d", len(sessions))
	}
	if !a.AdminRevoke(sessions[0].ID) {
		t.Fatal("révocation admin échouée")
	}
	if a.Verify(token, "http://localhost:5200") {
		t.Fatal("session révoquée par l'admin toujours valide")
	}
	if a.AdminRevoke("abcd") {
		t.Fatal("révocation admin d'un inconnu acceptée")
	}
}

func TestPendingPairings(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	if _, err := a.RequestPairing("http://localhost:5200"); err != nil {
		t.Fatal(err)
	}
	pending := a.PendingPairings()
	if len(pending) != 1 || pending[0].UserCode == "" {
		t.Fatalf("attente: %+v", pending)
	}
}
