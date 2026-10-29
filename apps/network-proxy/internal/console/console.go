// Package console provides a terminal console to approve pairings, list sessions
// and revoke them.
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

// Controller is the minimal abstraction the console needs.
type Controller interface {
	PendingPairings() []auth.Pairing
	ListSessions() []auth.SessionInfo
	Approve(id string, approve bool) error
	AdminRevoke(id string) bool
}

// Console drives pairing from a textual input/output stream.
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

// Run runs the interactive loop until quit, end of input or cancellation.
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

// poll announces new requests and sessions, then prompts for the next one.
func (c *Console) poll() {
	pending := c.ctrl.PendingPairings()
	sessions := c.ctrl.ListSessions()

	for _, p := range pending {
		if _, ok := c.seenPairings[p.ID]; ok {
			continue
		}
		c.seenPairings[p.ID] = struct{}{}
		c.queue = append(c.queue, p)
	}

	// Sessions present at startup are remembered without an announcement.
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

// handleLine answers a pending pairing, then interprets the line as a command.
// Only an explicit yes/no answers a pending request: an empty line or a typo
// asks again instead of silently denying a legitimate pairing.
func (c *Console) handleLine(line string) (quit bool) {
	line = strings.TrimSpace(line)
	if c.awaiting != nil {
		answer := classifyAnswer(line)
		if answer == answerUnclear {
			c.write(`Answer "y" to approve or "n" to deny. Approve? [y/N] `)
			return false
		}
		p := *c.awaiting
		c.awaiting = nil
		approve := answer == answerYes
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

// parseCommand splits a line into a lowercase command and its argument.
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

// answerKind classifies a line typed at the pairing prompt.
type answerKind int

const (
	// answerUnclear is an empty line, a typo or anything that is not a
	// deliberate yes/no: the console asks again.
	answerUnclear answerKind = iota
	answerYes
	answerNo
)

// classifyAnswer maps a line to an explicit answer; French variants are kept
// because the console is used in both languages.
func classifyAnswer(line string) answerKind {
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes", "o", "oui":
		return answerYes
	case "n", "no", "non":
		return answerNo
	default:
		return answerUnclear
	}
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return "—"
	}
	return t.Local().Format("2006-01-02 15:04:05")
}
