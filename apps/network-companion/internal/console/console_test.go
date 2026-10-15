package console

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumiboot/network-companion/internal/auth"
)

type approveCall struct {
	id      string
	approve bool
}

// fakeController est un Controller en mémoire pour les tests.
type fakeController struct {
	mu       sync.Mutex
	pending  []auth.Pairing
	sessions []auth.SessionInfo
	approved []approveCall
	revoked  []string
}

func (f *fakeController) PendingPairings() []auth.Pairing {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]auth.Pairing, len(f.pending))
	copy(out, f.pending)
	return out
}

func (f *fakeController) ListSessions() []auth.SessionInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]auth.SessionInfo, len(f.sessions))
	copy(out, f.sessions)
	return out
}

func (f *fakeController) Approve(id string, approve bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.approved = append(f.approved, approveCall{id: id, approve: approve})
	kept := f.pending[:0]
	for _, p := range f.pending {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	f.pending = kept
	return nil
}

func (f *fakeController) AdminRevoke(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = append(f.revoked, id)
	return true
}

func (f *fakeController) approvals() []approveCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]approveCall, len(f.approved))
	copy(out, f.approved)
	return out
}

func (f *fakeController) revocations() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.revoked))
	copy(out, f.revoked)
	return out
}

func pendingFixture() []auth.Pairing {
	return []auth.Pairing{{
		ID:        "pair-1",
		UserCode:  "123456",
		Origin:    "http://localhost:5173",
		ExpiresAt: time.Now().Add(10 * time.Minute),
	}}
}

func TestParseCommand(t *testing.T) {
	cases := []struct {
		in      string
		wantCmd string
		wantArg string
	}{
		{"help", "help", ""},
		{"  LIST  ", "list", ""},
		{"approve abc123", "approve", "abc123"},
		{"deny   654321", "deny", "654321"},
		{"revoke all", "revoke", "all"},
		{"quit", "quit", ""},
		{"", "", ""},
		{"APPROVE  x y", "approve", "x y"},
	}
	for _, tc := range cases {
		gotCmd, gotArg := parseCommand(tc.in)
		if gotCmd != tc.wantCmd || gotArg != tc.wantArg {
			t.Errorf("parseCommand(%q) = (%q,%q), attendu (%q,%q)", tc.in, gotCmd, gotArg, tc.wantCmd, tc.wantArg)
		}
	}
}

func TestIsAffirmative(t *testing.T) {
	for _, s := range []string{"y", "Y", "yes", "YES", "o", "O", "oui", "Oui", "  oui "} {
		if !isAffirmative(s) {
			t.Errorf("%q devrait être affirmatif", s)
		}
	}
	for _, s := range []string{"n", "no", "non", "", "peut-être", "yesx", "approve"} {
		if isAffirmative(s) {
			t.Errorf("%q ne devrait pas être affirmatif", s)
		}
	}
}

func TestRunApprovesPairingOnYes(t *testing.T) {
	fc := &fakeController{pending: pendingFixture()}
	var out bytes.Buffer
	c := New(fc, strings.NewReader("y\n"), &out)
	c.pollInterval = 5 * time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	calls := fc.approvals()
	if len(calls) != 1 || calls[0].id != "pair-1" || !calls[0].approve {
		t.Fatalf("approbations: %+v", calls)
	}
	if !strings.Contains(out.String(), "Nouvelle demande d'appairage") {
		t.Fatalf("annonce absente: %q", out.String())
	}
}

func TestRunDeniesPairingOnOtherInput(t *testing.T) {
	fc := &fakeController{pending: pendingFixture()}
	var out bytes.Buffer
	c := New(fc, strings.NewReader("n\n"), &out)
	c.pollInterval = 5 * time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	calls := fc.approvals()
	if len(calls) != 1 || calls[0].id != "pair-1" || calls[0].approve {
		t.Fatalf("refus attendu: %+v", calls)
	}
}

func TestRunReturnsOnEOF(t *testing.T) {
	c := New(&fakeController{}, strings.NewReader(""), io.Discard)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestRunQuit(t *testing.T) {
	fc := &fakeController{}
	var out bytes.Buffer
	c := New(fc, strings.NewReader("quit\n"), &out)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(out.String(), "Arrêt demandé") {
		t.Fatalf("arrêt non signalé: %q", out.String())
	}
}

func TestCommandApproveByCodeAndRevoke(t *testing.T) {
	fc := &fakeController{
		pending: pendingFixture(),
		sessions: []auth.SessionInfo{{
			ID:        "deadbeef",
			Origin:    "http://localhost:5173",
			ExpiresAt: time.Now().Add(time.Hour),
		}},
	}
	var out bytes.Buffer
	c := New(fc, strings.NewReader(""), &out)

	c.handleCommand("approve 123456")
	if calls := fc.approvals(); len(calls) != 1 || calls[0].id != "pair-1" || !calls[0].approve {
		t.Fatalf("approve par code: %+v", calls)
	}

	c.handleCommand("revoke deadbeef")
	if rev := fc.revocations(); len(rev) != 1 || rev[0] != "deadbeef" {
		t.Fatalf("revoke: %+v", rev)
	}

	c.handleCommand("list")
	if !strings.Contains(out.String(), "Sessions actives : 1") {
		t.Fatalf("list sans sessions: %q", out.String())
	}
}

func TestHandleCommandUnknown(t *testing.T) {
	var out bytes.Buffer
	c := New(&fakeController{}, strings.NewReader(""), &out)
	if quit := c.handleCommand("frobnicate"); quit {
		t.Fatal("commande inconnue ne doit pas quitter")
	}
	if !strings.Contains(out.String(), "Commande inconnue") {
		t.Fatalf("message attendu: %q", out.String())
	}
	if quit := c.handleCommand("exit"); !quit {
		t.Fatal("exit doit quitter")
	}
}
