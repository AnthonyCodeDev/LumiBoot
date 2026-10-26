// Package auth handles pairing and sessions for the local network proxy.
//
// v86 sends neither a header nor a WebSocket subprotocol: WISP session
// authentication therefore relies on a token passed in the URL query string
// (e.g. ws://127.0.0.1:37892/wisp/?token=...), checked with a constant-time
// comparison, combined with a strict Origin header check.
//
// Flow: the web page requests a pairing (RequestPairing), the user approves it
// from the local network proxy console (Approve), then the page exchanges the
// pairing for a session token (Exchange). The raw token is only stored hashed
// (SHA-256), with a TTL and a bound origin.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/url"
	"strings"
	"sync"
	"time"
)

var (
	// ErrOriginNotAllowed reports a disallowed origin.
	ErrOriginNotAllowed = errors.New("auth: origin not allowed")
	// ErrPairingNotFound reports an unknown or already consumed pairing.
	ErrPairingNotFound = errors.New("auth: pairing not found")
	// ErrPairingExpired reports an expired pairing.
	ErrPairingExpired = errors.New("auth: pairing expired")
	// ErrPairingNotApproved reports a pairing that is not approved yet.
	ErrPairingNotApproved = errors.New("auth: pairing not approved")
	// ErrOriginMismatch reports an origin different from the pairing origin.
	ErrOriginMismatch = errors.New("auth: origin differs from the pairing origin")
	// ErrPairingLimit reports a flood of pending pairing requests.
	ErrPairingLimit = errors.New("auth: too many pending pairing requests")
)

// Anti-flood caps on pending pairings (total and per origin).
const (
	maxPendingPairings  = 64
	maxPendingPerOrigin = 8
)

// Pairing statuses exposed by Status.
const (
	StatusPending  = "pending"
	StatusApproved = "approved"
	StatusDenied   = "denied"
)

// Pairing is a pending pairing request.
type Pairing struct {
	ID        string
	UserCode  string // human-readable code shown to the user for approval
	Origin    string
	ExpiresAt time.Time
	Status    string
}

// SessionInfo describes an active session (no secret).
// ID is the hex SHA-256 fingerprint of the token: irreversible, displayable in
// the local console and usable for revocation (AdminRevoke).
type SessionInfo struct {
	ID        string
	Origin    string
	ExpiresAt time.Time
}

// CloseFunc closes a transport (WebSocket + associated TCP connections). It is
// invoked by the session registry on revocation, expiration or server
// shutdown, never while holding the lock.
type CloseFunc func()

type session struct {
	hash      string
	origin    string
	expiresAt time.Time
	// closes maps EVERY active transport (WebSocket + net.Conn) of the session
	// to its close callback, keyed by transport ID. Several transports can share
	// the same token without overwriting each other.
	// Protected by the Authenticator mutex.
	closes map[string]*transport
}

// takeCloses removes and returns every transport of the session. The caller
// MUST hold the Authenticator mutex and invoke the callbacks OUTSIDE the lock.
func (s *session) takeCloses() []*transport {
	if len(s.closes) == 0 {
		return nil
	}
	out := make([]*transport, 0, len(s.closes))
	for id, t := range s.closes {
		out = append(out, t)
		delete(s.closes, id)
	}
	return out
}

// transport wraps a close callback so that it is invoked only once, whatever
// the number of concurrent close paths (revocation, expiration, shutdown,
// normal close). Prevents any double close.
type transport struct {
	once sync.Once
	fn   CloseFunc
}

func (t *transport) close() {
	if t == nil {
		return
	}
	t.once.Do(t.fn)
}

// closeAll invokes close callbacks outside the lock.
func closeAll(ts []*transport) {
	for _, t := range ts {
		t.close()
	}
}

// Authenticator manages origins, pairings and sessions. Thread-safe.
// The zero value is unusable: use NewAuthenticator.
type Authenticator struct {
	mu         sync.Mutex
	allowed    map[string]struct{}
	pairings   map[string]*Pairing
	sessions   map[string]*session
	pairingTTL time.Duration
	sessionTTL time.Duration
	randSource io.Reader
	now        func() time.Time
}

// NewAuthenticator builds an authenticator.
func NewAuthenticator(allowedOrigins []string, pairingTTL, sessionTTL time.Duration) *Authenticator {
	return NewAuthenticatorWithClock(allowedOrigins, pairingTTL, sessionTTL, rand.Reader, time.Now)
}

// NewAuthenticatorWithClock is the same but injects the randomness source and
// the clock (deterministic tests).
func NewAuthenticatorWithClock(allowedOrigins []string, pairingTTL, sessionTTL time.Duration, randSource io.Reader, now func() time.Time) *Authenticator {
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, o := range allowedOrigins {
		if n := NormalizeOrigin(o); n != "" {
			allowed[n] = struct{}{}
		}
	}
	return &Authenticator{
		allowed:    allowed,
		pairings:   make(map[string]*Pairing),
		sessions:   make(map[string]*session),
		pairingTTL: pairingTTL,
		sessionTTL: sessionTTL,
		randSource: randSource,
		now:        now,
	}
}

// NormalizeOrigin canonicalizes an origin (lowercase scheme + host, port kept,
// no path or trailing slash). Returns "" if invalid.
func NormalizeOrigin(origin string) string {
	u, err := url.Parse(strings.TrimSpace(origin))
	if err != nil {
		return ""
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return ""
	}
	out := u.Scheme + "://" + host
	if port := u.Port(); port != "" {
		out += ":" + port
	}
	return out
}

// IsOriginAllowed reports whether an origin is allowed (exact match after
// normalization). Loopback dev ports must appear in the configuration.
func (a *Authenticator) IsOriginAllowed(origin string) bool {
	n := NormalizeOrigin(origin)
	if n == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, ok := a.allowed[n]
	return ok
}

// RequestPairing creates a pairing request from an allowed origin.
func (a *Authenticator) RequestPairing(origin string) (Pairing, error) {
	n := NormalizeOrigin(origin)
	if n == "" {
		return Pairing{}, fmt.Errorf("%w: %q", ErrOriginNotAllowed, origin)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.allowed[n]; !ok {
		return Pairing{}, fmt.Errorf("%w: %q", ErrOriginNotAllowed, origin)
	}
	// Purge expired entries, then apply anti-flood caps (total and per origin).
	now := a.now()
	for id, p := range a.pairings {
		if now.After(p.ExpiresAt) {
			delete(a.pairings, id)
		}
	}
	if len(a.pairings) >= maxPendingPairings {
		return Pairing{}, ErrPairingLimit
	}
	perOrigin := 0
	for _, p := range a.pairings {
		if p.Origin == n {
			perOrigin++
		}
	}
	if perOrigin >= maxPendingPerOrigin {
		return Pairing{}, ErrPairingLimit
	}
	id, err := randomString(a.randSource, 12)
	if err != nil {
		return Pairing{}, err
	}
	code, err := a.uniqueUserCodeLocked()
	if err != nil {
		return Pairing{}, err
	}
	p := &Pairing{
		ID:        id,
		UserCode:  code,
		Origin:    n,
		ExpiresAt: a.now().Add(a.pairingTTL),
		Status:    StatusPending,
	}
	a.pairings[id] = p
	return *p, nil
}

// Status returns the state of a pairing.
func (a *Authenticator) Status(pairingID string) (Pairing, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, ok := a.pairings[pairingID]
	if !ok {
		return Pairing{}, false
	}
	if a.now().After(p.ExpiresAt) {
		delete(a.pairings, pairingID)
		return Pairing{}, false
	}
	return *p, true
}

// Approve approves (ok=true) or denies (ok=false) a pending pairing.
// A denial removes the request; an approval marks it as exchangeable.
func (a *Authenticator) Approve(pairingID string, ok bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, found := a.pairings[pairingID]
	if !found {
		return ErrPairingNotFound
	}
	if a.now().After(p.ExpiresAt) {
		delete(a.pairings, pairingID)
		return ErrPairingExpired
	}
	if !ok {
		delete(a.pairings, pairingID)
		return nil
	}
	cp := *p
	cp.Status = StatusApproved
	a.pairings[pairingID] = &cp
	return nil
}

// Exchange converts an approved pairing into a session token.
// The raw token (32 random bytes, base64url) is only returned here and is
// stored hashed (SHA-256) only. Single use.
func (a *Authenticator) Exchange(pairingID, origin string) (token string, expiresAt time.Time, err error) {
	n := NormalizeOrigin(origin)
	a.mu.Lock()
	defer a.mu.Unlock()
	p, ok := a.pairings[pairingID]
	if !ok {
		return "", time.Time{}, ErrPairingNotFound
	}
	if a.now().After(p.ExpiresAt) {
		delete(a.pairings, pairingID)
		return "", time.Time{}, ErrPairingExpired
	}
	if p.Status != StatusApproved {
		return "", time.Time{}, ErrPairingNotApproved
	}
	if p.Origin != n {
		return "", time.Time{}, fmt.Errorf("%w: %q", ErrOriginMismatch, origin)
	}
	raw, err := randomString(a.randSource, 32)
	if err != nil {
		return "", time.Time{}, err
	}
	expiresAt = a.now().Add(a.sessionTTL)
	a.sessions[hashToken(raw)] = &session{hash: hashToken(raw), origin: p.Origin, expiresAt: expiresAt}
	delete(a.pairings, pairingID) // single use
	return raw, expiresAt, nil
}

// Verify checks a session token for a given origin.
// Constant-time comparison; checks the TTL and the origin binding.
func (a *Authenticator) Verify(token, origin string) bool {
	_, _, ok := a.lookup(token, origin)
	return ok
}

// VerifySession is the same as Verify but also returns the session metadata
// (no secret): ID (token fingerprint) and expiration.
func (a *Authenticator) VerifySession(token, origin string) (SessionInfo, bool) {
	id, s, ok := a.lookup(token, origin)
	if !ok {
		return SessionInfo{}, false
	}
	return SessionInfo{ID: id, Origin: s.origin, ExpiresAt: s.expiresAt}, true
}

// AttachSession atomically verifies the token and registers a NEW close
// transport for the session, identified by a distinct transport ID. Several
// transports can be attached to the same token without overwriting each other:
// revocation or expiration closes them ALL. Atomic: there is no window where a
// concurrent revocation could go unnoticed. Returns the session metadata and
// the transport ID to pass back to DetachSession.
func (a *Authenticator) AttachSession(token, origin string, onClose CloseFunc) (SessionInfo, string, bool) {
	a.mu.Lock()
	id, s, expired, ok := a.lookupLocked(token, origin)
	if !ok {
		a.mu.Unlock()
		closeAll(expired)
		return SessionInfo{}, "", false
	}
	tid, err := randomString(a.randSource, 8)
	if err != nil {
		a.mu.Unlock()
		return SessionInfo{}, "", false
	}
	if s.closes == nil {
		s.closes = make(map[string]*transport)
	}
	s.closes[tid] = &transport{fn: onClose}
	info := SessionInfo{ID: id, Origin: s.origin, ExpiresAt: s.expiresAt}
	a.mu.Unlock()
	return info, tid, true
}

// DetachSession removes ONLY the identified transport (normal WebSocket close)
// without revoking the session: the other transports attached to the same token
// stay active. The raw token identifies the session; the transport ID comes
// from AttachSession.
func (a *Authenticator) DetachSession(token, transportID string) {
	if token == "" || transportID == "" {
		return
	}
	want := hashToken(token)
	a.mu.Lock()
	for h, s := range a.sessions {
		if subtle.ConstantTimeCompare([]byte(h), []byte(want)) == 1 {
			delete(s.closes, transportID)
			break
		}
	}
	a.mu.Unlock()
}

// CloseAllSessions invokes every close callback (server shutdown).
// Sessions are not deleted (the server is stopping). Invocation is idempotent
// per transport (sync.Once).
func (a *Authenticator) CloseAllSessions() {
	a.mu.Lock()
	var closes []*transport
	for _, s := range a.sessions {
		for _, t := range s.closes {
			closes = append(closes, t)
		}
	}
	a.mu.Unlock()
	closeAll(closes)
}

// lookup verifies a token outside the lock; see lookupLocked. The transports of
// an expired session are closed OUTSIDE the lock (never a callback under the
// mutex).
func (a *Authenticator) lookup(token, origin string) (string, *session, bool) {
	a.mu.Lock()
	id, s, expired, ok := a.lookupLocked(token, origin)
	a.mu.Unlock()
	closeAll(expired)
	return id, s, ok
}

// lookupLocked resolves a valid session from a token and an origin.
// An expired session is purged; its transports are returned to the caller for
// closing OUTSIDE the lock: an expired session can never leave a WebSocket
// open (purge and close are atomic from the lock's point of view).
// The caller MUST hold a.mu.
func (a *Authenticator) lookupLocked(token, origin string) (string, *session, []*transport, bool) {
	if token == "" {
		return "", nil, nil, false
	}
	n := NormalizeOrigin(origin)
	if n == "" {
		return "", nil, nil, false
	}
	want := hashToken(token)
	for h, s := range a.sessions {
		if subtle.ConstantTimeCompare([]byte(h), []byte(want)) == 1 {
			if a.now().After(s.expiresAt) {
				expired := s.takeCloses()
				delete(a.sessions, h)
				return "", nil, expired, false
			}
			if subtle.ConstantTimeCompare([]byte(s.origin), []byte(n)) != 1 {
				return "", nil, nil, false
			}
			return h, s, nil, true
		}
	}
	return "", nil, nil, false
}

// Revoke revokes the session matching the raw token. Returns false if unknown.
// Closes the associated transport (callback outside the lock).
func (a *Authenticator) Revoke(token string) bool {
	if token == "" {
		return false
	}
	want := hashToken(token)
	var closes []*transport
	found := false
	a.mu.Lock()
	for h, s := range a.sessions {
		if subtle.ConstantTimeCompare([]byte(h), []byte(want)) == 1 {
			closes = s.takeCloses()
			delete(a.sessions, h)
			found = true
			break
		}
	}
	a.mu.Unlock()
	closeAll(closes)
	return found
}

// ListSessions lists the active sessions (no secret). An expired session is
// purged AND its transports closed (outside the lock): listing never leaves an
// expired connection open.
func (a *Authenticator) ListSessions() []SessionInfo {
	a.mu.Lock()
	now := a.now()
	out := make([]SessionInfo, 0, len(a.sessions))
	var closes []*transport
	for h, s := range a.sessions {
		if now.After(s.expiresAt) {
			closes = append(closes, s.takeCloses()...)
			delete(a.sessions, h)
			continue
		}
		out = append(out, SessionInfo{ID: h, Origin: s.origin, ExpiresAt: s.expiresAt})
	}
	a.mu.Unlock()
	closeAll(closes)
	return out
}

// AdminRevoke revokes a session by its fingerprint (ID from ListSessions).
// Reserved for the local network proxy console. Closes the associated
// transport.
func (a *Authenticator) AdminRevoke(id string) bool {
	if id == "" {
		return false
	}
	var closes []*transport
	found := false
	a.mu.Lock()
	for h, s := range a.sessions {
		if subtle.ConstantTimeCompare([]byte(h), []byte(id)) == 1 {
			closes = s.takeCloses()
			delete(a.sessions, h)
			found = true
			break
		}
	}
	a.mu.Unlock()
	closeAll(closes)
	return found
}

// CleanupExpired purges expired pairings and sessions. An expired session has
// ALL its transports closed (callbacks invoked outside the lock): an expiration
// actually closes every WebSocket and its associated net.Conn.
func (a *Authenticator) CleanupExpired() {
	var closes []*transport
	a.mu.Lock()
	now := a.now()
	for id, p := range a.pairings {
		if now.After(p.ExpiresAt) {
			delete(a.pairings, id)
		}
	}
	for h, s := range a.sessions {
		if now.After(s.expiresAt) {
			closes = append(closes, s.takeCloses()...)
			delete(a.sessions, h)
		}
	}
	a.mu.Unlock()
	closeAll(closes)
}

// PendingPairings lists non-expired pending pairings (console).
func (a *Authenticator) PendingPairings() []Pairing {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	var out []Pairing
	for id, p := range a.pairings {
		if now.After(p.ExpiresAt) {
			delete(a.pairings, id)
			continue
		}
		if p.Status == StatusPending {
			out = append(out, *p)
		}
	}
	return out
}

func (a *Authenticator) uniqueUserCodeLocked() (string, error) {
	for tries := 0; tries < 20; tries++ {
		n, err := rand.Int(a.randSource, big.NewInt(1000000))
		if err != nil {
			return "", fmt.Errorf("auth: randomness unavailable: %w", err)
		}
		code := fmt.Sprintf("%06d", n.Int64())
		dup := false
		for _, p := range a.pairings {
			if p.UserCode == code {
				dup = true
				break
			}
		}
		if !dup {
			return code, nil
		}
	}
	return "", errors.New("auth: unable to generate a unique code")
}

// hashToken hashes a raw token (SHA-256 hex) for storage.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", sum)
}

func randomString(src io.Reader, nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := io.ReadFull(src, buf); err != nil {
		return "", fmt.Errorf("auth: randomness unavailable: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
