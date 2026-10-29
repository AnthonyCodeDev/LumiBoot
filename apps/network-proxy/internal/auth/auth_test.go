package auth

import (
	"crypto/rand"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lumiboot/network-proxy/internal/testutil"
)

// testOrigin is the deployment origin these tests allow and send, derived from
// `E2E_HOST` / `E2E_PORT` (`http://127.0.0.1:5200` by default).
var testOrigin = testutil.TestOrigin()

// altOrigin is a second allowed origin, a production-looking one.
var altOrigin = testutil.AltOrigin()

func testAuth(now *time.Time) *Authenticator {
	return NewAuthenticatorWithClock(
		[]string{testOrigin, altOrigin},
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
		testOrigin,
		testOrigin + "/", // trailing slash tolerated
		strings.ToUpper(testOrigin) + "/some/path", // case + path tolerated
		altOrigin,
	}
	for _, o := range allowed {
		if !a.IsOriginAllowed(o) {
			t.Fatalf("allowed origin refused: %s", o)
		}
	}
	denied := []string{
		"", "null", testutil.WithPort(testOrigin, 5201), testutil.HostileOrigin(),
		testOrigin + ".evil.com", testutil.WithScheme(testOrigin, "ftp"), "not-a-url",
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

	p, err := a.RequestPairing(testOrigin)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if p.ID == "" || p.UserCode == "" || p.Status != StatusPending {
		t.Fatalf("incomplete pairing: %+v", p)
	}

	if _, _, err := a.Exchange(p.ID, testOrigin); !errors.Is(err, ErrPairingNotApproved) {
		t.Fatalf("pre-approval exchange: %v", err)
	}

	if err := a.Approve(p.ID, true); err != nil {
		t.Fatalf("approve: %v", err)
	}
	token, expiresAt, err := a.Exchange(p.ID, testOrigin)
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if token == "" || expiresAt.IsZero() {
		t.Fatal("empty token")
	}
	if _, _, err := a.Exchange(p.ID, testOrigin); !errors.Is(err, ErrPairingNotFound) {
		t.Fatalf("pairing reuse: %v", err)
	}

	if !a.Verify(token, testOrigin) {
		t.Fatal("valid token refused")
	}
	if a.Verify(token, altOrigin) {
		t.Fatal("token accepted from another origin")
	}
	if a.Verify("", testOrigin) {
		t.Fatal("empty token accepted")
	}
	if a.Verify("garbage", testOrigin) {
		t.Fatal("unknown token accepted")
	}

	if got := len(a.ListSessions()); got != 1 {
		t.Fatalf("sessions: %d", got)
	}
	if !a.Revoke(token) {
		t.Fatal("revocation failed")
	}
	if a.Verify(token, testOrigin) {
		t.Fatal("revoked token accepted")
	}
	if a.Revoke(token) {
		t.Fatal("double revocation accepted")
	}
}

func TestPairingDenied(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	p, err := a.RequestPairing(testOrigin)
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
	if _, err := a.RequestPairing(testutil.HostileOrigin()); !errors.Is(err, ErrOriginNotAllowed) {
		t.Fatalf("hostile origin: %v", err)
	}
	p, err := a.RequestPairing(testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Approve(p.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := a.Exchange(p.ID, altOrigin); !errors.Is(err, ErrOriginMismatch) {
		t.Fatalf("different origin accepted: %v", err)
	}
}

func TestExpiry(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	p, err := a.RequestPairing(testOrigin)
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
	p2, err := a.RequestPairing(testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Approve(p2.ID, true); err != nil {
		t.Fatal(err)
	}
	token, _, err := a.Exchange(p2.ID, testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Hour) // beyond SessionTokenTTL
	if a.Verify(token, testOrigin) {
		t.Fatal("expired session accepted")
	}
	if got := len(a.ListSessions()); got != 0 {
		t.Fatalf("expired sessions listed: %d", got)
	}
}

func TestAdminRevoke(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	p, _ := a.RequestPairing(testOrigin)
	_ = a.Approve(p.ID, true)
	token, _, _ := a.Exchange(p.ID, testOrigin)
	sessions := a.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("sessions: %d", len(sessions))
	}
	if !a.AdminRevoke(sessions[0].ID) {
		t.Fatal("admin revocation failed")
	}
	if a.Verify(token, testOrigin) {
		t.Fatal("session revoked by admin still valid")
	}
	if a.AdminRevoke("abcd") {
		t.Fatal("admin revocation of an unknown session accepted")
	}
}

func TestPendingPairings(t *testing.T) {
	now := time.Now()
	a := testAuth(&now)
	if _, err := a.RequestPairing(testOrigin); err != nil {
		t.Fatal(err)
	}
	pending := a.PendingPairings()
	if len(pending) != 1 || pending[0].UserCode == "" {
		t.Fatalf("pending: %+v", pending)
	}
}

func issueToken(t *testing.T, a *Authenticator) string {
	t.Helper()
	p, err := a.RequestPairing(testOrigin)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := a.Approve(p.ID, true); err != nil {
		t.Fatalf("approve: %v", err)
	}
	token, _, err := a.Exchange(p.ID, testOrigin)
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
	info, tid, ok := a.AttachSession(token, testOrigin, func() { closed <- struct{}{} })
	if !ok || info.ID == "" || tid == "" {
		t.Fatal("transport attachment refused")
	}
	if _, _, ok := a.AttachSession("wrong", testOrigin, func() {}); ok {
		t.Fatal("attachment of an invalid token accepted")
	}
	if _, _, ok := a.AttachSession(token, altOrigin, func() {}); ok {
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
		info, _, ok := a.AttachSession(token, testOrigin, func() { closed <- struct{}{} })
		if !ok {
			t.Fatal("attachment refused")
		}
		return token, info.ID, closed
	}

	_, id, closed := attach()
	if !a.AdminRevoke(id) {
		t.Fatal("AdminRevoke failed")
	}
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("callback not invoked after AdminRevoke")
	}

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
	_, tid, ok := a.AttachSession(token, testOrigin, func() { closed <- struct{}{} })
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
		if _, err := a.RequestPairing(testOrigin); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if _, err := a.RequestPairing(testOrigin); !errors.Is(err, ErrPairingLimit) {
		t.Fatalf("per-origin cap not applied: %v", err)
	}
	if _, err := a.RequestPairing(altOrigin); err != nil {
		t.Fatalf("other origin wrongly blocked: %v", err)
	}
	now = now.Add(11 * time.Minute)
	if _, err := a.RequestPairing(testOrigin); err != nil {
		t.Fatalf("after cleanup: %v", err)
	}
}

func expectClosed(t *testing.T, ch <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatalf("%s: close callback not invoked", label)
	}
}

// TestTwoTransportsSameTokenRevokeClosesBoth: two WebSockets on one token must not
// overwrite each other; Revoke closes both.
func TestTwoTransportsSameTokenRevokeClosesBoth(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	_, tidA, okA := a.AttachSession(token, testOrigin, func() { closedA <- struct{}{} })
	_, tidB, okB := a.AttachSession(token, testOrigin, func() { closedB <- struct{}{} })
	if !okA || !okB || tidA == "" || tidB == "" || tidA == tidB {
		t.Fatalf("attachments: okA=%v okB=%v tidA=%q tidB=%q", okA, okB, tidA, tidB)
	}
	if !a.Revoke(token) {
		t.Fatal("revocation failed")
	}
	expectClosed(t, closedA, "transport A")
	expectClosed(t, closedB, "transport B")
}

// TestDetachOnlyRemovesTargetTransport: detaching one transport must not close the other.
func TestDetachOnlyRemovesTargetTransport(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	_, tidA, _ := a.AttachSession(token, testOrigin, func() { closedA <- struct{}{} })
	a.AttachSession(token, testOrigin, func() { closedB <- struct{}{} })
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

// TestVerifyExpiredClosesAllTransports: Verify purges an expired session and closes
// all its transports.
func TestVerifyExpiredClosesAllTransports(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	a.AttachSession(token, testOrigin, func() { closedA <- struct{}{} })
	a.AttachSession(token, testOrigin, func() { closedB <- struct{}{} })

	now = now.Add(2 * time.Hour) // beyond SessionTokenTTL
	if a.Verify(token, testOrigin) {
		t.Fatal("expired session accepted")
	}
	expectClosed(t, closedA, "Verify transport A")
	expectClosed(t, closedB, "Verify transport B")
}

// TestListSessionsExpiredClosesAllTransports: ListSessions never purges a session
// without closing its connections.
func TestListSessionsExpiredClosesAllTransports(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	a.AttachSession(token, testOrigin, func() { closedA <- struct{}{} })
	a.AttachSession(token, testOrigin, func() { closedB <- struct{}{} })

	now = now.Add(2 * time.Hour)
	if got := a.ListSessions(); len(got) != 0 {
		t.Fatalf("expired sessions listed: %d", len(got))
	}
	expectClosed(t, closedA, "ListSessions transport A")
	expectClosed(t, closedB, "ListSessions transport B")
}

// TestCleanupExpiredClosesAllTransports: the sweep closes every transport.
func TestCleanupExpiredClosesAllTransports(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	closedA := make(chan struct{}, 1)
	closedB := make(chan struct{}, 1)
	a.AttachSession(token, testOrigin, func() { closedA <- struct{}{} })
	a.AttachSession(token, testOrigin, func() { closedB <- struct{}{} })

	now = now.Add(2 * time.Hour)
	a.CleanupExpired()
	expectClosed(t, closedA, "sweep transport A")
	expectClosed(t, closedB, "sweep transport B")
}

// TestCloseAllSessionsClosesEveryTransport: shutdown closes every transport.
func TestCloseAllSessionsClosesEveryTransport(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)

	chans := make([]chan struct{}, 0, 4)
	attach := func(token string) {
		ch := make(chan struct{}, 1)
		chans = append(chans, ch)
		a.AttachSession(token, testOrigin, func() { ch <- struct{}{} })
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

// TestCloseAllSessionsIdempotent: sync.Once prevents a double close.
func TestCloseAllSessionsIdempotent(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	var calls int32
	a.AttachSession(token, testOrigin, func() { atomic.AddInt32(&calls, 1) })
	a.CloseAllSessions()
	a.CloseAllSessions()
	a.CloseAllSessions()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("callback invoked %d times, expected 1 (double close)", got)
	}
}

// TestConcurrentAttachDetachRevoke: no deadlock nor double close under -race,
// and the per-token cap holds under concurrency.
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
			_, tid, ok := a.AttachSession(token, testOrigin, func() {
				atomic.AddInt32(&closed, 1)
			})
			if ok {
				tids[i] = tid
			}
		}(i)
	}
	wg.Wait()

	attached := 0
	for _, tid := range tids {
		if tid != "" {
			attached++
		}
	}
	if attached != MaxTransportsPerToken {
		t.Fatalf("attached=%d, expected the per-token cap %d", attached, MaxTransportsPerToken)
	}

	// Detach half the attached transports: revocation only closes the rest.
	detached := 0
	for i := 0; i < n; i += 2 {
		if tids[i] != "" {
			a.DetachSession(token, tids[i])
			detached++
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

	want := int32(attached - detached)
	got := atomic.LoadInt32(&closed)
	if got > int32(attached) {
		t.Fatalf("double close: %d closes for %d transports", got, attached)
	}
	if got != want {
		t.Fatalf("closes=%d, expected %d (non-detached transports)", got, want)
	}
}

// TestAttachSessionTransportCap: a token accepts a bounded number of
// simultaneous transports, and detaching one frees a slot.
func TestAttachSessionTransportCap(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)
	token := issueToken(t, a)

	var tids []string
	for i := 0; i < MaxTransportsPerToken; i++ {
		_, tid, ok := a.AttachSession(token, testOrigin, func() {})
		if !ok {
			t.Fatalf("attachment %d refused below the cap", i)
		}
		tids = append(tids, tid)
	}
	if _, _, ok := a.AttachSession(token, testOrigin, func() {}); ok {
		t.Fatalf("attachment above the cap of %d accepted", MaxTransportsPerToken)
	}

	a.DetachSession(token, tids[0])
	if _, _, ok := a.AttachSession(token, testOrigin, func() {}); !ok {
		t.Fatal("attachment refused after DetachSession freed a slot")
	}
}

// TestStatusForRequiresPairingOrigin: an allowed origin cannot read a pairing
// created by another allowed origin.
func TestStatusForRequiresPairingOrigin(t *testing.T) {
	t.Parallel()
	now := time.Now()
	a := testAuth(&now)

	p, err := a.RequestPairing(testOrigin)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := a.StatusFor(p.ID, testOrigin); !ok || got.ID != p.ID {
		t.Fatalf("same-origin status refused: %+v ok=%v", got, ok)
	}
	if _, ok := a.StatusFor(p.ID, altOrigin); ok {
		t.Fatal("pairing status readable from another allowed origin")
	}
	if _, ok := a.StatusFor(p.ID, ""); ok {
		t.Fatal("pairing status readable without an origin")
	}
	if _, ok := a.StatusFor(p.ID, testutil.HostileOrigin()); ok {
		t.Fatal("pairing status readable from a forbidden origin")
	}
	if got, ok := a.Status(p.ID); !ok || got.ID != p.ID {
		t.Fatal("origin-free Status must still work for internal callers")
	}
}
