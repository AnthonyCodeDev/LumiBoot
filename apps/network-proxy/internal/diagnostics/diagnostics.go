// Package diagnostics expose des compteurs d'activité thread-safe du proxy réseau local.
package diagnostics

import "sync"

// Directions : TX = proxy -> invitée (téléchargement vers l'OS virtualisé),
// RX = invitée -> proxy (envoi depuis l'OS virtualisé).
type Counters struct {
	mu               sync.Mutex
	totalConnections uint64
	activeConns      uint64
	bytesTX          uint64
	bytesRX          uint64
	errors           uint64
	blocked          uint64
	rejectedAuth     uint64
}

// Snapshot est une copie immuable des compteurs, exposée via /health.
type Snapshot struct {
	TotalConnections    uint64 `json:"totalConnections"`
	ActiveConnections   uint64 `json:"activeConnections"`
	BytesTX             uint64 `json:"bytesTX"`
	BytesRX             uint64 `json:"bytesRX"`
	Errors              uint64 `json:"errors"`
	BlockedDestinations uint64 `json:"blockedDestinations"`
	RejectedAuth        uint64 `json:"rejectedAuth"`
}

// IncConnections enregistre une nouvelle connexion (incrémente total + actives).
func (c *Counters) IncConnections() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.totalConnections++
	c.activeConns++
}

// DecConnections décrémente les connexions actives (jamais sous zéro).
func (c *Counters) DecConnections() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.activeConns > 0 {
		c.activeConns--
	}
}

// AddTX ajoute des octets proxy -> invitée.
func (c *Counters) AddTX(n uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bytesTX += n
}

// AddRX ajoute des octets invitée -> proxy.
func (c *Counters) AddRX(n uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bytesRX += n
}

// IncErrors enregistre une erreur de transfert ou de protocole.
func (c *Counters) IncErrors() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.errors++
}

// IncBlocked enregistre une destination refusée par la politique.
func (c *Counters) IncBlocked() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.blocked++
}

// IncRejectedAuth enregistre une tentative d'accès rejetée (origine/token).
func (c *Counters) IncRejectedAuth() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rejectedAuth++
}

// Snapshot copie les compteurs.
func (c *Counters) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return Snapshot{
		TotalConnections:    c.totalConnections,
		ActiveConnections:   c.activeConns,
		BytesTX:             c.bytesTX,
		BytesRX:             c.bytesRX,
		Errors:              c.errors,
		BlockedDestinations: c.blocked,
		RejectedAuth:        c.rejectedAuth,
	}
}
