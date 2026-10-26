package diagnostics

import "testing"

func TestCounters(t *testing.T) {
	var c Counters
	c.IncConnections()
	c.IncConnections()
	c.DecConnections()
	c.AddTX(100)
	c.AddRX(50)
	c.IncErrors()
	c.IncBlocked()
	c.IncRejectedAuth()

	snap := c.Snapshot()
	if snap.TotalConnections != 2 || snap.ActiveConnections != 1 {
		t.Fatalf("connections: %+v", snap)
	}
	if snap.BytesTX != 100 || snap.BytesRX != 50 {
		t.Fatalf("bytes: %+v", snap)
	}
	if snap.Errors != 1 || snap.BlockedDestinations != 1 || snap.RejectedAuth != 1 {
		t.Fatalf("errors: %+v", snap)
	}

	// Never below zero.
	c.DecConnections()
	c.DecConnections()
	if got := c.Snapshot().ActiveConnections; got != 0 {
		t.Fatalf("active below zero: %d", got)
	}
}
