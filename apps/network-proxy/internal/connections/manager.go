// Package connections suit les flux TCP actifs, applique les quotas et les
// timeouts d'inactivité, et optionnellement limite la bande passante globale.
package connections

import (
	"context"
	"errors"
	"net"
	"sync"
	"time"
)

// CloseThrottled est la raison WISP renvoyée quand un quota est atteint.
const CloseThrottled = byte(0x49)

// ErrGlobalLimit signale le dépassement du quota global.
var ErrGlobalLimit = errors.New("connections: quota global atteint")

// ErrSessionLimit signale le dépassement du quota par session WISP.
var ErrSessionLimit = errors.New("connections: quota de session atteint")

// StreamInfo décrit un flux actif (exposé aux diagnostics et aux tests).
type StreamInfo struct {
	ID           uint32
	Host         string
	Port         uint16
	IP           string
	BytesIn      uint64 // invitée -> réseau
	BytesOut     uint64 // réseau -> invitée
	StartedAt    time.Time
	LastActivity time.Time
}

type entry struct {
	mu   sync.Mutex
	info StreamInfo
	conn net.Conn
}

// Manager suit les flux actifs. Zéro valeur inutilisable : passer par NewManager.
// Thread-safe.
type Manager struct {
	mu            sync.Mutex
	maxTotal      int
	maxPerSession int
	streams       map[string]map[uint32]*entry
	total         int
	limiter       *tokenBucket
}

// NewManager construit un gestionnaire.
// maxTotal borne le nombre total de flux, maxPerSession le nombre par session
// WISP (identifiée par sessionID). bandwidthBytesPerSecond <= 0 désactive la
// limitation de bande passante.
func NewManager(maxTotal, maxPerSession int, bandwidthBytesPerSecond int64) *Manager {
	if maxTotal <= 0 {
		maxTotal = 64
	}
	if maxPerSession <= 0 {
		maxPerSession = 16
	}
	return &Manager{
		maxTotal:      maxTotal,
		maxPerSession: maxPerSession,
		streams:       make(map[string]map[uint32]*entry),
		limiter:       newTokenBucket(bandwidthBytesPerSecond),
	}
}

// Add enregistre un nouveau flux après contrôle des quotas.
func (m *Manager) Add(sessionID string, id uint32, host string, port uint16, ip string, conn net.Conn) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.total >= m.maxTotal {
		return ErrGlobalLimit
	}
	sess := m.streams[sessionID]
	if sess == nil {
		sess = make(map[uint32]*entry)
		m.streams[sessionID] = sess
	}
	if len(sess) >= m.maxPerSession {
		return ErrSessionLimit
	}
	if _, dup := sess[id]; dup {
		return errors.New("connections: stream_id dupliqué")
	}
	now := time.Now()
	sess[id] = &entry{
		info: StreamInfo{
			ID: id, Host: host, Port: port, IP: ip,
			StartedAt: now, LastActivity: now,
		},
		conn: conn,
	}
	m.total++
	return nil
}

// Remove oublie un flux et ferme sa connexion TCP. Idempotent.
func (m *Manager) Remove(sessionID string, id uint32) {
	m.mu.Lock()
	sess := m.streams[sessionID]
	e, ok := sess[id]
	if ok {
		delete(sess, id)
		if len(sess) == 0 {
			delete(m.streams, sessionID)
		}
		m.total--
	}
	m.mu.Unlock()
	if ok && e.conn != nil {
		_ = e.conn.Close()
	}
}

// SetConn attache la connexion TCP à un flux réservé. Renvoie false si le
// flux n'existe plus (réservation annulée entre-temps).
func (m *Manager) SetConn(sessionID string, id uint32, conn net.Conn) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.streams[sessionID][id]
	if !ok {
		return false
	}
	e.mu.Lock()
	e.info.LastActivity = time.Now()
	e.mu.Unlock()
	e.conn = conn
	return true
}

// Conn renvoie la connexion TCP d'un flux.
func (m *Manager) Conn(sessionID string, id uint32) (net.Conn, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.streams[sessionID][id]; ok {
		return e.conn, true
	}
	return nil, false
}

// Exists indique si un flux est suivi.
func (m *Manager) Exists(sessionID string, id uint32) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.streams[sessionID][id]
	return ok
}

// Touch rafraîchit l'activité d'un flux.
func (m *Manager) Touch(sessionID string, id uint32) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.streams[sessionID][id]; ok {
		e.mu.Lock()
		e.info.LastActivity = time.Now()
		e.mu.Unlock()
	}
}

// AddBytesIn comptabilise des octets invitée -> réseau.
func (m *Manager) AddBytesIn(sessionID string, id uint32, n uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.streams[sessionID][id]; ok {
		e.mu.Lock()
		e.info.BytesIn += n
		e.info.LastActivity = time.Now()
		e.mu.Unlock()
	}
}

// AddBytesOut comptabilise des octets réseau -> invitée.
func (m *Manager) AddBytesOut(sessionID string, id uint32, n uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.streams[sessionID][id]; ok {
		e.mu.Lock()
		e.info.BytesOut += n
		e.info.LastActivity = time.Now()
		e.mu.Unlock()
	}
}

// Count renvoie le nombre total de flux actifs.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.total
}

// SessionCount renvoie le nombre de flux actifs d'une session.
func (m *Manager) SessionCount(sessionID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.streams[sessionID])
}

// Snapshot copie l'état des flux actifs.
func (m *Manager) Snapshot() []StreamInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]StreamInfo, 0, m.total)
	for _, sess := range m.streams {
		for _, e := range sess {
			e.mu.Lock()
			out = append(out, e.info)
			e.mu.Unlock()
		}
	}
	return out
}

// SweepIdle ferme les flux inactifs depuis idleTimeout et renvoie leur nombre.
func (m *Manager) SweepIdle(idleTimeout time.Duration) int {
	cutoff := time.Now().Add(-idleTimeout)
	type victim struct {
		session string
		id      uint32
		conn    net.Conn
	}
	var victims []victim
	m.mu.Lock()
	for session, sess := range m.streams {
		for id, e := range sess {
			e.mu.Lock()
			idle := e.info.LastActivity.Before(cutoff)
			e.mu.Unlock()
			if idle {
				victims = append(victims, victim{session: session, id: id, conn: e.conn})
				delete(sess, id)
				m.total--
			}
		}
		if len(sess) == 0 {
			delete(m.streams, session)
		}
	}
	m.mu.Unlock()
	for _, v := range victims {
		if v.conn != nil {
			_ = v.conn.Close()
		}
	}
	return len(victims)
}

// Throttle applique la limitation de bande passante globale (token bucket).
// Sans effet si la limite est désactivée. n est le nombre d'octets transférés.
// L'attente est annulable : dès que ctx est annulé, Throttle rend la main.
func (m *Manager) Throttle(ctx context.Context, n int) {
	m.limiter.consume(ctx, n)
}

// tokenBucket est un seau à jetons minimaliste pour la bande passante.
type tokenBucket struct {
	mu     sync.Mutex
	rate   float64 // octets par seconde, <= 0 = désactivé
	tokens float64
	last   time.Time
}

func newTokenBucket(bytesPerSecond int64) *tokenBucket {
	return &tokenBucket{rate: float64(bytesPerSecond), last: time.Now()}
}

func (b *tokenBucket) consume(ctx context.Context, n int) {
	if n <= 0 {
		return
	}
	b.mu.Lock()
	if b.rate <= 0 {
		b.mu.Unlock()
		return
	}
	now := time.Now()
	elapsed := now.Sub(b.last).Seconds()
	b.last = now
	b.tokens += elapsed * b.rate
	if b.tokens > b.rate {
		b.tokens = b.rate // capacité = 1 seconde de débit
	}
	b.tokens -= float64(n)
	wait := time.Duration(0)
	if b.tokens < 0 {
		wait = time.Duration(-b.tokens / b.rate * float64(time.Second))
	}
	b.mu.Unlock()
	if wait <= 0 {
		return
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}
