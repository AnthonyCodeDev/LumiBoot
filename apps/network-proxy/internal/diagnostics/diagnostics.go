// Package diagnostics exposes thread-safe activity counters for the local
// network proxy.
package diagnostics

import "sync"

// Directions: TX = proxy -> guest (download to the virtualized OS),
// RX = guest -> proxy (upload from the virtualized OS).
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

// Snapshot is an immutable copy of the counters, exposed through /health.
type Snapshot struct {
	TotalConnections    uint64 `json:"totalConnections"`
	ActiveConnections   uint64 `json:"activeConnections"`
	BytesTX             uint64 `json:"bytesTX"`
	BytesRX             uint64 `json:"bytesRX"`
	Errors              uint64 `json:"errors"`
	BlockedDestinations uint64 `json:"blockedDestinations"`
	RejectedAuth        uint64 `json:"rejectedAuth"`
}

// IncConnections records a new connection (increments total + active).
func (c *Counters) IncConnections() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.totalConnections++
	c.activeConns++
}

// DecConnections decrements the active connections (never below zero).
func (c *Counters) DecConnections() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.activeConns > 0 {
		c.activeConns--
	}
}

// AddTX adds proxy -> guest bytes.
func (c *Counters) AddTX(n uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bytesTX += n
}

// AddRX adds guest -> proxy bytes.
func (c *Counters) AddRX(n uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.bytesRX += n
}

// IncErrors records a transfer or protocol error.
func (c *Counters) IncErrors() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.errors++
}

// IncBlocked records a destination refused by the policy.
func (c *Counters) IncBlocked() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.blocked++
}

// IncRejectedAuth records a rejected access attempt (origin/token).
func (c *Counters) IncRejectedAuth() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rejectedAuth++
}

// Snapshot copies the counters.
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
