package console

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumiboot/network-proxy/internal/auth"
	"github.com/lumiboot/network-proxy/internal/testutil"
)

type approveCall struct {
	id      string
	approve bool
}

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
		Origin:    testutil.WebDevOrigin(),
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
			t.Errorf("parseCommand(%q) = (%q,%q), want (%q,%q)", tc.in, gotCmd, gotArg, tc.wantCmd, tc.wantArg)
		}
	}
}

func TestClassifyAnswer(t *testing.T) {
	for _, s := range []string{"y", "Y", "yes", "YES", "o", "O", "oui", "Oui", "  oui "} {
		if got := classifyAnswer(s); got != answerYes {
			t.Errorf("%q should be a yes, got %v", s, got)
		}
	}
	for _, s := range []string{"n", "N", "no", "NO", "non", "Non", " non "} {
		if got := classifyAnswer(s); got != answerNo {
			t.Errorf("%q should be a no, got %v", s, got)
		}
	}
	for _, s := range []string{"", "  ", "maybe", "yesx", "approve", "0", "quit"} {
		if got := classifyAnswer(s); got != answerUnclear {
			t.Errorf("%q should be unclear, got %v", s, got)
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
		t.Fatalf("approvals: %+v", calls)
	}
	if !strings.Contains(out.String(), "New pairing request") {
		t.Fatalf("missing announcement: %q", out.String())
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
		t.Fatalf("denial expected: %+v", calls)
	}
}

func TestEmptyLineKeepsPairingPendingThenApproves(t *testing.T) {
	fc := &fakeController{pending: pendingFixture()}
	var out bytes.Buffer
	// A bare Enter must not count as a refusal: the console asks again.
	c := New(fc, strings.NewReader("\ny\n"), &out)
	c.pollInterval = 5 * time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	calls := fc.approvals()
	if len(calls) != 1 || calls[0].id != "pair-1" || !calls[0].approve {
		t.Fatalf("empty line must not deny the pairing: %+v", calls)
	}
	if !strings.Contains(out.String(), `Answer "y"`) {
		t.Fatalf("missing re-prompt on empty line: %q", out.String())
	}
	if strings.Contains(out.String(), "Denied:") {
		t.Fatalf("empty line denied the pairing: %q", out.String())
	}
}

func TestUnknownAnswerKeepsPairingPendingThenDenies(t *testing.T) {
	fc := &fakeController{pending: pendingFixture()}
	var out bytes.Buffer
	c := New(fc, strings.NewReader("maybe\nn\n"), &out)
	c.pollInterval = 5 * time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	calls := fc.approvals()
	if len(calls) != 1 || calls[0].id != "pair-1" || calls[0].approve {
		t.Fatalf("unknown answer must be ignored, then denial: %+v", calls)
	}
	if !strings.Contains(out.String(), `Answer "y"`) {
		t.Fatalf("missing re-prompt on unknown answer: %q", out.String())
	}
	if !strings.Contains(out.String(), "Denied:") {
		t.Fatalf("final denial missing: %q", out.String())
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
	if !strings.Contains(out.String(), "Shutdown requested") {
		t.Fatalf("shutdown not reported: %q", out.String())
	}
}

func TestCommandApproveByCodeAndRevoke(t *testing.T) {
	fc := &fakeController{
		pending: pendingFixture(),
		sessions: []auth.SessionInfo{{
			ID:        "deadbeef",
			Origin:    testutil.WebDevOrigin(),
			ExpiresAt: time.Now().Add(time.Hour),
		}},
	}
	var out bytes.Buffer
	c := New(fc, strings.NewReader(""), &out)

	c.handleCommand("approve 123456")
	if calls := fc.approvals(); len(calls) != 1 || calls[0].id != "pair-1" || !calls[0].approve {
		t.Fatalf("approve by code: %+v", calls)
	}

	c.handleCommand("revoke deadbeef")
	if rev := fc.revocations(); len(rev) != 1 || rev[0] != "deadbeef" {
		t.Fatalf("revoke: %+v", rev)
	}

	c.handleCommand("list")
	if !strings.Contains(out.String(), "Active sessions: 1") {
		t.Fatalf("list without sessions: %q", out.String())
	}
}

func TestHandleCommandUnknown(t *testing.T) {
	var out bytes.Buffer
	c := New(&fakeController{}, strings.NewReader(""), &out)
	if quit := c.handleCommand("frobnicate"); quit {
		t.Fatal("unknown command must not quit")
	}
	if !strings.Contains(out.String(), "Unknown command") {
		t.Fatalf("expected message: %q", out.String())
	}
	if quit := c.handleCommand("exit"); !quit {
		t.Fatal("exit must quit")
	}
}
