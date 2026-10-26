// Package console provides an interactive console to drive the local network
// proxy from the terminal: display pairing requests (approve/deny), active
// sessions and revocation. No HTTP access is needed; the web administration
// page has been removed.
package console

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/lumiboot/network-proxy/internal/auth"
)

// Controller is the minimal abstraction the console needs to drive pairing and
// sessions. *auth.Authenticator satisfies it directly.
type Controller interface {
	PendingPairings() []auth.Pairing
	ListSessions() []auth.SessionInfo
	Approve(id string, approve bool) error
	AdminRevoke(id string) bool
}

// Console drives pairing from a textual input/output stream.
// The interactive loop (Run) executes in a single goroutine; writes are
// protected by a mutex.
type Console struct {
	ctrl Controller
	in   io.Reader
	out  io.Writer

	pollInterval time.Duration

	mu sync.Mutex // protects writes to out

	seenPairings   map[string]struct{}
	seenSessions   map[string]struct{}
	sessionsSeeded bool
	awaiting       *auth.Pairing
	queue          []auth.Pairing
}

// New builds a console fed by in and writing to out.
func New(ctrl Controller, in io.Reader, out io.Writer) *Console {
	return &Console{
		ctrl:         ctrl,
		in:           in,
		out:          out,
		pollInterval: time.Second,
		seenPairings: make(map[string]struct{}),
		seenSessions: make(map[string]struct{}),
	}
}

// Run executes the interactive loop until `quit`/`exit`, end of input (EOF) or
// context cancellation. The reader goroutine handles EOF without blocking
// (non-interactive input / pipe).
func (c *Console) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	lines := make(chan string)
	go c.readLines(ctx, lines)

	ticker := time.NewTicker(c.pollInterval)
	defer ticker.Stop()

	c.poll()

	for {
		select {
		case <-ctx.Done():
			return nil
		case line, ok := <-lines:
			if !ok {
				return nil
			}
			if c.handleLine(line) {
				return nil
			}
		case <-ticker.C:
			c.poll()
		}
	}
}

// readLines reads stdin line by line and pushes into lines; closes lines on EOF.
func (c *Console) readLines(ctx context.Context, lines chan<- string) {
	defer close(lines)
	sc := bufio.NewScanner(c.in)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		select {
		case lines <- sc.Text():
		case <-ctx.Done():
			return
		}
	}
}

// poll queries the controller: announces new requests and sessions, then shows
// the decision prompt for the next request.
func (c *Console) poll() {
	pending := c.ctrl.PendingPairings()
	sessions := c.ctrl.ListSessions()

	// New pairing requests (never announced twice).
	for _, p := range pending {
		if _, ok := c.seenPairings[p.ID]; ok {
			continue
		}
		c.seenPairings[p.ID] = struct{}{}
		c.queue = append(c.queue, p)
	}

	// New sessions (sessions already present at startup are remembered without
	// an individual announcement).
	var fresh []auth.SessionInfo
	if !c.sessionsSeeded {
		c.sessionsSeeded = true
		for _, s := range sessions {
			c.seenSessions[s.ID] = struct{}{}
		}
	} else {
		for _, s := range sessions {
			if _, ok := c.seenSessions[s.ID]; !ok {
				c.seenSessions[s.ID] = struct{}{}
				fresh = append(fresh, s)
			}
		}
	}

	for _, s := range fresh {
		c.announceSession(s)
	}
	c.promptNext()
}

// promptNext shows the decision prompt for the next request.
func (c *Console) promptNext() {
	if c.awaiting != nil || len(c.queue) == 0 {
		return
	}
	p := c.queue[0]
	c.queue = c.queue[1:]
	c.awaiting = &p
	c.announcePairing(p)
	c.write("Approve? [y/N] ")
}

// handleLine processes an entered line. If a pairing decision is pending, the
// line is interpreted as the answer (y/yes/o/oui = approve, anything else =
// deny). Returns true to request shutdown.
func (c *Console) handleLine(line string) (quit bool) {
	line = strings.TrimSpace(line)
	if c.awaiting != nil {
		p := *c.awaiting
		c.awaiting = nil
		approve := isAffirmative(line)
		if err := c.ctrl.Approve(p.ID, approve); err != nil {
			c.printf("Decision failed for %s: %v\n", p.UserCode, err)
		} else if approve {
			c.printf("Approved: %s (%s).\n", p.UserCode, p.Origin)
		} else {
			c.printf("Denied: %s (%s).\n", p.UserCode, p.Origin)
		}
		c.promptNext()
		return false
	}
	return c.handleCommand(line)
}

// handleCommand executes a textual command.
func (c *Console) handleCommand(line string) (quit bool) {
	if line == "" {
		return false
	}
	cmd, arg := parseCommand(line)
	switch cmd {
	case "help":
		c.printHelp()
	case "list", "status":
		c.printStatus()
	case "approve":
		c.decide(arg, true)
	case "deny", "refuse":
		c.decide(arg, false)
	case "revoke":
		c.revoke(arg)
	case "quit", "exit":
		c.write("Shutdown requested.\n")
		return true
	default:
		c.printf("Unknown command: %q. Type \"help\".\n", cmd)
	}
	return false
}

// decide approves or denies a request identified by ID or user code.
func (c *Console) decide(arg string, approve bool) {
	if arg == "" {
		c.write("Usage: approve|deny <id|code>.\n")
		return
	}
	p, ok := c.findPending(arg)
	if !ok {
		c.printf("No matching request for %q.\n", arg)
		return
	}
	c.removeFromQueue(p.ID)
	if err := c.ctrl.Approve(p.ID, approve); err != nil {
		c.printf("Failed: %v\n", err)
		return
	}
	if approve {
		c.printf("Approved: %s (%s).\n", p.UserCode, p.Origin)
	} else {
		c.printf("Denied: %s (%s).\n", p.UserCode, p.Origin)
	}
}

// revoke revokes a session by ID (or unique prefix), or all of them.
func (c *Console) revoke(arg string) {
	if arg == "" {
		c.write("Usage: revoke <id|all>.\n")
		return
	}
	if strings.EqualFold(arg, "all") {
		n := 0
		for _, s := range c.ctrl.ListSessions() {
			if c.ctrl.AdminRevoke(s.ID) {
				n++
			}
		}
		c.printf("%d session(s) revoked.\n", n)
		return
	}
	id, ok := c.findSession(arg)
	if !ok {
		c.printf("Session not found: %q.\n", arg)
		return
	}
	if c.ctrl.AdminRevoke(id) {
		c.printf("Session revoked: %s\n", id)
	} else {
		c.printf("Revocation failed: %s\n", id)
	}
}

func (c *Console) findPending(arg string) (auth.Pairing, bool) {
	for _, p := range c.ctrl.PendingPairings() {
		if p.ID == arg || strings.EqualFold(p.UserCode, arg) {
			return p, true
		}
	}
	return auth.Pairing{}, false
}

func (c *Console) findSession(arg string) (string, bool) {
	sessions := c.ctrl.ListSessions()
	for _, s := range sessions {
		if s.ID == arg {
			return s.ID, true
		}
	}
	match, count := "", 0
	for _, s := range sessions {
		if strings.HasPrefix(s.ID, arg) {
			match, count = s.ID, count+1
		}
	}
	if count == 1 {
		return match, true
	}
	return "", false
}

func (c *Console) removeFromQueue(id string) {
	if len(c.queue) == 0 {
		return
	}
	kept := c.queue[:0]
	for _, p := range c.queue {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	c.queue = kept
}

func (c *Console) printStatus() {
	pending := c.ctrl.PendingPairings()
	sessions := c.ctrl.ListSessions()

	c.write("\nLocal network proxy status\n")
	c.printf("  Pending pairing requests: %d\n", len(pending))
	for _, p := range pending {
		c.printf("    - code %s | %s | expires %s\n", p.UserCode, p.Origin, formatTime(p.ExpiresAt))
	}
	c.printf("  Active sessions: %d\n", len(sessions))
	for _, s := range sessions {
		c.printf("    - %s | %s | expires %s\n", s.ID, s.Origin, formatTime(s.ExpiresAt))
	}
	c.write("\n")
}

func (c *Console) printHelp() {
	c.write(`Commands:
  help                 show this help
  list, status         status, pending requests and active sessions
  approve <id|code>    approve a pairing request
  deny <id|code>       deny a pairing request
  revoke <id|all>      revoke a session (or all of them)
  quit, exit           stop the local network proxy
`)
}

func (c *Console) announcePairing(p auth.Pairing) {
	c.write("\n[New pairing request]\n")
	c.printf("  Origin  : %s\n", p.Origin)
	c.printf("  Code    : %s\n", p.UserCode)
	c.printf("  Expires : %s\n", formatTime(p.ExpiresAt))
}

func (c *Console) announceSession(s auth.SessionInfo) {
	c.write("\n[New active session]\n")
	c.printf("  ID      : %s\n", s.ID)
	c.printf("  Origin  : %s\n", s.Origin)
	c.printf("  Expires : %s\n", formatTime(s.ExpiresAt))
}

func (c *Console) write(s string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, _ = io.WriteString(c.out, s)
}

func (c *Console) printf(format string, args ...any) {
	c.write(fmt.Sprintf(format, args...))
}

// parseCommand splits a line into a command (lowercase) and an optional
// argument.
func parseCommand(line string) (cmd, arg string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", ""
	}
	if i := strings.IndexFunc(line, unicode.IsSpace); i >= 0 {
		return strings.ToLower(line[:i]), strings.TrimSpace(line[i+1:])
	}
	return strings.ToLower(line), ""
}

func isAffirmative(line string) bool {
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes", "o", "oui":
		return true
	default:
		return false
	}
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	return t.Local().Format("2006-01-02 15:04:05")
}
