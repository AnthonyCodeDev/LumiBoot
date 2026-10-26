package auth

import (
	"crypto/rand"
	"errors"
	"sync"
	"sync/atomic"
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
		"http://localhost:5200/",          // trailing slash tolerated
		"HTTP://LOCALHOST:5200/some/path", // case + path tolerated
		"https://lumiboot.app",
	}
	for _, o := range allowed {
		if !a.IsOriginAllowed(o) {
			t.Fatalf("allowed origin refused: %s", o)
		}
	}
	denied := []string{
		"", "null", "http://localhost:5201", "http://evil.com",
		"http://localhost:5200.evil.com", "ftp://localhost:5200", "not-a-url",
	}
	for _, o := range denied {
		if a.IsOriginAllowed(o) {
			t.Fatalf("forbidden origin accepted: %q", o)
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
		t.Fatalf("incomplete pairing: %+v", p)
	}

	// Exchange before approval: refused.
	if _, _, err := a.Exchange(p.ID, "http://localhost:5200"); !errors.Is(err, ErrPairingNotApproved) {
		t.Fatalf("pre-approval exchange: %v", err)
	}

	if err := a.Approve(p.ID, true); err != nil {
		t.Fatalf("approve: %v", err)
	}
	token, expiresAt, err := a.Exchange(p.ID, "http://localhost:5200")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if token == "" || expiresAt.IsZero() {
		t.Fatal("empty token")
	}
	// Single use.
	if _, _, err := a.Exchange(p.ID, "http://localhost:5200"); !errors.Is(err, ErrPairingNotFound) {
		t.Fatalf("pairing reuse: %v", err)
	}

	if !a.Verify(token, "http://localhost:5200") {
		t.Fatal("valid token refused")
	}
	// Origin binding.
	if a.Verify(token, "https://lumiboot.app") {
		t.Fatal("token accepted from another origin")
	}
	if a.Verify("", "http://localhost:5200") {
		t.Fatal("empty token accepted")
	}
	if a.Verify("garbage", "http://localhost:5200") {
		t.Fatal("unknown token accepted")
	}

	if got := len(a.ListSessions()); got != 1 {
		t.Fatalf("sessions: %d", got)
	}
	if !a.Revoke(token) {
		t.Fatal("revocation failed")
	}
	if a.Verify(token, "http://localhost:5200") {
		t.Fatal("revoked token accepted")
	}
	if a.Revoke(token) {
		t.Fatal("double revocation accepted")
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
		t.Fatal("denied pairing still present")
	}
}

func TestPairingBadOrigin(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	if _, err := a.RequestPairing("http://evil.com"); !errors.Is(err, ErrOriginNotAllowed) {
		t.Fatalf("hostile origin: %v", err)
	}
	p, err := a.RequestPairing("http://localhost:5200")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Approve(p.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.Exchange(p.ID, "https://lumiboot.app"); !errors.Is(err, ErrOriginMismatch) {
		t.Fatalf("different origin accepted: %v", err)
	}
}

func TestExpiry(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	p, err := a.RequestPairing("http://localhost:5200")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(11 * time.Minute) // beyond PairingTTL
	if _, ok := a.Status(p.ID); ok {
		t.Fatal("expired pairing still present")
	}
	if err := a.Approve(p.ID, true); !errors.Is(err, ErrPairingNotFound) && !errors.Is(err, ErrPairingExpired) {
		t.Fatalf("expired approve: %v", err)
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
	now = now.Add(2 * time.Hour) // beyond SessionTokenTTL
	if a.Verify(token, "http://localhost:5200") {
		t.Fatal("expired session accepted")
	}
	if got := len(a.ListSessions()); got != 0 {
		t.Fatalf("expired sessions listed: %d", got)
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
		t.Fatal("admin revocation failed")
	}
	if a.Verify(token, "http://localhost:5200") {
		t.Fatal("session revoked by admin still valid")
	}
	if a.AdminRevoke("abcd") {
		t.Fatal("admin revocation of an unknown session accepted")
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
		t.Fatalf("pending: %+v", pending)
	}
}

// issueToken pairs and exchanges a test session.
func issueToken(t *testing.T, a *Authenticator) string {
	t.Helper()
	p, err := a.RequestPairing("http://localhost:5200")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := a.Approve(p.ID, true); err != nil {
		t.Fatalf("approve: %v", err)
	}
	token, _, err := a.Exchange(p.ID, "http://localhost:5200")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	return token
}

func TestTransportClosedOnRevoke(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closed := make(chan struct{}, 1)
	info, tid, ok := a.AttachSession(token, "http://localhost:5200", func() { closed <- struct{}{} })
	if !ok || info.ID == "" || tid == "" {
		t.Fatal("transport attachment refused")
	}
	// Invalid token / different origin: no attachment.
	if _, _, ok := a.AttachSession("wrong", "http://localhost:5200", func() {}); ok {
		t.Fatal("attachment of an invalid token accepted")
	}
	if _, _, ok := a.AttachSession(token, "https://lumiboot.app", func() {}); ok {
		t.Fatal("attachment from another origin accepted")
	}

	if !a.Revoke(token) {
		t.Fatal("revocation failed")
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("close callback not invoked after Revoke")
	}
}

func TestTransportClosedOnAdminRevokeAndExpiry(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)

	attach := func() (token, id string, closed chan struct{}) {
		token = issueToken(t, a)
		closed = make(chan struct{}, 1)
		info, _, ok := a.AttachSession(token, "http://localhost:5200", func() { closed <- struct{}{} })
		if !ok {
			t.Fatal("attachment refused")
		}
		return token, info.ID, closed
	}

	// AdminRevoke.
	_, id, closed := attach()
	if !a.AdminRevoke(id) {
		t.Fatal("AdminRevoke failed")
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("callback not invoked after AdminRevoke")
	}

	// Expiration: CleanupExpired closes the transport.
	_, _, closed = attach()
	now = now.Add(2 * time.Hour)
	a.CleanupExpired()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("callback not invoked after expiration")
	}
}

func TestDetachSessionPreventsCallback(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)
	closed := make(chan struct{}, 1)
	_, tid, ok := a.AttachSession(token, "http://localhost:5200", func() { closed <- struct{}{} })
	if !ok {
		t.Fatal("attachment refused")
	}
	a.DetachSession(token, tid)
	if !a.Revoke(token) {
		t.Fatal("revocation failed")
	}
	select {
	case <-closed:
		t.Fatal("callback invoked after DetachSession")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPairingFloodLimit(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	for i := 0; i < maxPendingPerOrigin; i++ {
		if _, err := a.RequestPairing("http://localhost:5200"); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if _, err := a.RequestPairing("http://localhost:5200"); !errors.Is(err, ErrPairingLimit) {
		t.Fatalf("per-origin cap not applied: %v", err)
	}
	// Another allowed origin is not penalized.
	if _, err := a.RequestPairing("https://lumiboot.app"); err != nil {
		t.Fatalf("other origin wrongly blocked: %v", err)
	}
	// Purging expired entries frees the quota.
	now = now.Add(11 * time.Minute)
	if _, err := a.RequestPairing("http://localhost:5200"); err != nil {
		t.Fatalf("after cleanup: %v", err)
	}
}

// --- P0 regressions: multi-transport registry per token ---

// expectClosed waits for a close callback invocation.
func expectClosed(t *testing.T, ch <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s: close callback not invoked", label)
	}
}

// TestTwoTransportsSameTokenRevokeClosesBoth: P0 bug — two WebSockets attached
// to the same token must no longer overwrite each other (single onClose);
// Revoke closes 2/2.
func TestTwoTransportsSameTokenRevokeClosesBoth(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	_, tidA, okA := a.AttachSession(token, "http://localhost:5200", func() { closedA <- struct{}{} })
	_, tidB, okB := a.AttachSession(token, "http://localhost:5200", func() { closedB <- struct{}{} })
	if !okA || !okB || tidA == "" || tidB == "" || tidA == tidB {
		t.Fatalf("attachments: okA=%v okB=%v tidA=%q tidB=%q", okA, okB, tidA, tidB)
	}
	if !a.Revoke(token) {
		t.Fatal("revocation failed")
	}
	expectClosed(t, closedA, "transport A")
	expectClosed(t, closedB, "transport B")
}

// TestDetachOnlyRemovesTargetTransport: P0 bug — detaching A must NOT close B.
func TestDetachOnlyRemovesTargetTransport(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	_, tidA, _ := a.AttachSession(token, "http://localhost:5200", func() { closedA <- struct{}{} })
	a.AttachSession(token, "http://localhost:5200", func() { closedB <- struct{}{} })
	a.DetachSession(token, tidA)

	if !a.Revoke(token) {
		t.Fatal("revocation failed")
	}
	expectClosed(t, closedB, "transport B")
	select {
	case <-closedA:
		t.Fatal("transport A closed although it had been detached")
	case <-time.After(100 * time.Millisecond):
	}
}

// TestVerifyExpiredClosesAllTransports: an expired session encountered by
// Verify is purged AND all its transports are closed (no leak).
func TestVerifyExpiredClosesAllTransports(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	a.AttachSession(token, "http://localhost:5200", func() { closedA <- struct{}{} })
	a.AttachSession(token, "http://localhost:5200", func() { closedB <- struct{}{} })

	now = now.Add(2 * time.Hour) // beyond SessionTokenTTL
	if a.Verify(token, "http://localhost:5200") {
		t.Fatal("expired session accepted")
	}
	expectClosed(t, closedA, "Verify transport A")
	expectClosed(t, closedB, "Verify transport B")
}

// TestListSessionsExpiredClosesAllTransports: ListSessions never purges an
// expired session without closing its connections.
func TestListSessionsExpiredClosesAllTransports(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	a.AttachSession(token, "http://localhost:5200", func() { closedA <- struct{}{} })
	a.AttachSession(token, "http://localhost:5200", func() { closedB <- struct{}{} })

	now = now.Add(2 * time.Hour)
	if got := a.ListSessions(); len(got) != 0 {
		t.Fatalf("expired sessions listed: %d", len(got))
	}
	expectClosed(t, closedA, "ListSessions transport A")
	expectClosed(t, closedB, "ListSessions transport B")
}

// TestCleanupExpiredClosesAllTransports: the periodic sweep closes ALL
// transports of an expired session.
func TestCleanupExpiredClosesAllTransports(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	a.AttachSession(token, "http://localhost:5200", func() { closedA <- struct{}{} })
	a.AttachSession(token, "http://localhost:5200", func() { closedB <- struct{}{} })

	now = now.Add(2 * time.Hour)
	a.CleanupExpired()
	expectClosed(t, closedA, "sweep transport A")
	expectClosed(t, closedB, "sweep transport B")
}

// TestCloseAllSessionsClosesEveryTransport: server shutdown closes every
// transport of every session (distinct tokens).
func TestCloseAllSessionsClosesEveryTransport(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)

	chans := make([]chan struct{}, 0, 4)
	attach := func(token string) {
		ch := make(chan struct{}, 1)
		chans = append(chans, ch)
		a.AttachSession(token, "http://localhost:5200", func() { ch <- struct{}{} })
	}
	attach(issueToken(t, a))
	attach(issueToken(t, a))
	attach(issueToken(t, a))
	attach(issueToken(t, a))

	a.CloseAllSessions()
	for i, ch := range chans {
		expectClosed(t, ch, "CloseAllSessions"+string(rune('A'+i)))
	}
}

// TestCloseAllSessionsIdempotent: the per-transport sync.Once prevents any
// double close even if CloseAllSessions is called again.
func TestCloseAllSessionsIdempotent(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	var calls int32
	a.AttachSession(token, "http://localhost:5200", func() { atomic.AddInt32(&calls, 1) })
	a.CloseAllSessions()
	a.CloseAllSessions()
	a.CloseAllSessions()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("callback invoked %d times, expected 1 (double close)", got)
	}
}

// TestConcurrentAttachDetachRevoke: under -race, no deadlock and no double close
// when attach/detach/revoke overlap.
func TestConcurrentAttachDetachRevoke(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	const n = 32
	var closed int32
	tids := make([]string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, tid, ok := a.AttachSession(token, "http://localhost:5200", func() {
				atomic.AddInt32(&closed, 1)
			})
			if ok {
				tids[i] = tid
			}
		}(i)
	}
	wg.Wait()

	// Detach half of the transports: revocation must only close the rest.
	for i := 0; i < n; i += 2 {
		if tids[i] != "" {
			a.DetachSession(token, tids[i])
		}
	}

	done := make(chan struct{})
	go func() {
		a.Revoke(token)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Revoke blocked (deadlock?)")
	}

	got := atomic.LoadInt32(&closed)
	if got > n {
		t.Fatalf("double close: %d closes for %d transports", got, n)
	}
	if got != int32(n/2) {
		t.Fatalf("closes=%d, expected %d (non-detached transports)", got, n/2)
	}
}
