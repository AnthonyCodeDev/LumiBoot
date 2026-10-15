// Package auth gère l'appairage et les sessions du compagnon.
//
// v86 n'envoie ni en-tête ni sous-protocole WebSocket : l'authentification de
// la session WISP repose donc sur un token transmis en query string de l'URL
// (ex. ws://127.0.0.1:37892/wisp/?token=...), vérifié avec une comparaison à
// temps constant, combiné à un contrôle strict de l'en-tête Origin.
//
// Flux : la page web demande un appairage (RequestPairing), l'utilisateur
// approuve depuis la page d'admin locale (Approve), puis la page échange
// l'appairage contre un token de session (Exchange). Le token brut n'est
// stocké que sous forme hachée (SHA-256), avec TTL et origine liée.
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
	// ErrOriginNotAllowed signale une origine non autorisée.
	ErrOriginNotAllowed = errors.New("auth: origine non autorisée")
	// ErrPairingNotFound signale un appairage inconnu ou déjà consommé.
	ErrPairingNotFound = errors.New("auth: appairage introuvable")
	// ErrPairingExpired signale un appairage expiré.
	ErrPairingExpired = errors.New("auth: appairage expiré")
	// ErrPairingNotApproved signale un appairage pas encore approuvé.
	ErrPairingNotApproved = errors.New("auth: appairage non approuvé")
	// ErrOriginMismatch signale une origine différente de celle d'appairage.
	ErrOriginMismatch = errors.New("auth: origine différente de celle d'appairage")
)

// Statuts d'appairage exposés par Status.
const (
	StatusPending  = "pending"
	StatusApproved = "approved"
	StatusDenied   = "denied"
)

// Pairing est une demande d'appairage en attente.
type Pairing struct {
	ID        string
	UserCode  string // code lisible affiché à l'utilisateur pour approbation
	Origin    string
	ExpiresAt time.Time
	Status    string
}

// SessionInfo décrit une session active (sans secret).
// ID est l'empreinte SHA-256 hex du token : non réversible, affichable à
// l'admin local et utilisable pour révoquer (AdminRevoke).
type SessionInfo struct {
	ID        string
	Origin    string
	ExpiresAt time.Time
}

type session struct {
	hash      string
	origin    string
	expiresAt time.Time
}

// Authenticator gère origines, appairages et sessions. Thread-safe.
// Le zéro valeur est inutilisable : passer par NewAuthenticator.
type Authenticator struct {
	mu          sync.Mutex
	allowed     map[string]struct{}
	pairings    map[string]*Pairing
	sessions    map[string]*session
	pairingTTL  time.Duration
	sessionTTL  time.Duration
	randSource  io.Reader
	now         func() time.Time
}

// NewAuthenticator construit un authentificateur.
func NewAuthenticator(allowedOrigins []string, pairingTTL, sessionTTL time.Duration) *Authenticator {
	return NewAuthenticatorWithClock(allowedOrigins, pairingTTL, sessionTTL, rand.Reader, time.Now)
}

// NewAuthenticatorWithClock est identique mais injecte source d'aléa et horloge
// (tests déterministes).
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

// NormalizeOrigin canonise une origine (schéma + hôte minuscules, port conservé,
// sans chemin ni slash final). Renvoie "" si invalide.
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

// IsOriginAllowed indique si une origine est autorisée (match exact après
// normalisation). Les ports dev loopback doivent figurer dans la configuration.
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

// RequestPairing crée une demande d'appairage depuis une origine autorisée.
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

// Status renvoie l'état d'un appairage.
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

// Approve approuve (ok=true) ou refuse (ok=false) un appairage en attente.
// Un refus supprime la demande ; une approbation la marque échangeable.
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

// Exchange convertit un appairage approuvé en token de session.
// Le token brut (32 octets aléatoires, base64url) n'est renvoyé qu'ici et
// n'est stocké que sous forme hachée (SHA-256). Usage unique.
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
	delete(a.pairings, pairingID) // usage unique
	return raw, expiresAt, nil
}

// Verify contrôle un token de session pour une origine donnée.
// Comparaison à temps constant ; vérifie TTL et liaison d'origine.
func (a *Authenticator) Verify(token, origin string) bool {
	if token == "" {
		return false
	}
	n := NormalizeOrigin(origin)
	if n == "" {
		return false
	}
	want := hashToken(token)
	a.mu.Lock()
	defer a.mu.Unlock()
	for h, s := range a.sessions {
		if subtle.ConstantTimeCompare([]byte(h), []byte(want)) == 1 {
			if a.now().After(s.expiresAt) {
				delete(a.sessions, h)
				return false
			}
			return subtle.ConstantTimeCompare([]byte(s.origin), []byte(n)) == 1
		}
	}
	return false
}

// Revoke révoque la session correspondant au token brut. Renvoie false si inconnu.
func (a *Authenticator) Revoke(token string) bool {
	if token == "" {
		return false
	}
	want := hashToken(token)
	a.mu.Lock()
	defer a.mu.Unlock()
	for h := range a.sessions {
		if subtle.ConstantTimeCompare([]byte(h), []byte(want)) == 1 {
			delete(a.sessions, h)
			return true
		}
	}
	return false
}

// ListSessions liste les sessions actives (sans secret), expirées purgées.
func (a *Authenticator) ListSessions() []SessionInfo {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	out := make([]SessionInfo, 0, len(a.sessions))
	for h, s := range a.sessions {
		if now.After(s.expiresAt) {
			delete(a.sessions, h)
			continue
		}
		out = append(out, SessionInfo{ID: h, Origin: s.origin, ExpiresAt: s.expiresAt})
	}
	return out
}

// AdminRevoke révoque une session par son empreinte (ID de ListSessions).
// Réservé à la page d'admin locale.
func (a *Authenticator) AdminRevoke(id string) bool {
	if id == "" {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for h := range a.sessions {
		if subtle.ConstantTimeCompare([]byte(h), []byte(id)) == 1 {
			delete(a.sessions, h)
			return true
		}
	}
	return false
}

// CleanupExpired purge appairages et sessions expirés.
func (a *Authenticator) CleanupExpired() {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	for id, p := range a.pairings {
		if now.After(p.ExpiresAt) {
			delete(a.pairings, id)
		}
	}
	for h, s := range a.sessions {
		if now.After(s.expiresAt) {
			delete(a.sessions, h)
		}
	}
}

// PendingPairings liste les appairages en attente non expirés (page d'admin).
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
			return "", fmt.Errorf("auth: aléa indisponible: %w", err)
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
	return "", errors.New("auth: impossible de générer un code unique")
}

// hashToken hache un token brut (SHA-256 hex) pour stockage.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", sum)
}

func randomString(src io.Reader, nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := io.ReadFull(src, buf); err != nil {
		return "", fmt.Errorf("auth: aléa indisponible: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
