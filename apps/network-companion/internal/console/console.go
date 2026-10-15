// Package console fournit une console interactive pour piloter le compagnon
// depuis le terminal : affichage des demandes d'appairage (accepter/refuser),
// sessions actives et révocation. Aucun accès HTTP n'est nécessaire ; la page
// d'administration web a été retirée.
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

	"github.com/lumiboot/network-companion/internal/auth"
)

// Controller est l'abstraction minimale dont la console a besoin pour piloter
// l'appairage et les sessions. *auth.Authenticator la satisfait directement.
type Controller interface {
	PendingPairings() []auth.Pairing
	ListSessions() []auth.SessionInfo
	Approve(id string, approve bool) error
	AdminRevoke(id string) bool
}

// Console pilote l'appairage depuis un flux d'entrée/sortie textuel.
// La boucle interactive (Run) s'exécute dans une seule goroutine ; les
// écritures sont protégées par un mutex.
type Console struct {
	ctrl Controller
	in   io.Reader
	out  io.Writer

	pollInterval time.Duration

	mu sync.Mutex // protège les écritures sur out

	seenPairings   map[string]struct{}
	seenSessions   map[string]struct{}
	sessionsSeeded bool
	awaiting       *auth.Pairing
	queue          []auth.Pairing
}

// New construit une console alimentée par in et écrivant sur out.
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

// Run exécute la boucle interactive jusqu'à `quit`/`exit`, fin de l'entrée
// (EOF) ou annulation du contexte. La goroutine de lecture gère EOF sans
// bloquer (entrée non interactive / pipe).
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

// readLines lit stdin ligne par ligne et pousse vers lines ; ferme lines à EOF.
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

// poll interroge le contrôleur : annonce les nouvelles demandes et sessions,
// puis affiche le prompt de décision pour la prochaine demande.
func (c *Console) poll() {
	pending := c.ctrl.PendingPairings()
	sessions := c.ctrl.ListSessions()

	// Nouvelles demandes d'appairage (jamais ré-annoncées).
	for _, p := range pending {
		if _, ok := c.seenPairings[p.ID]; ok {
			continue
		}
		c.seenPairings[p.ID] = struct{}{}
		c.queue = append(c.queue, p)
	}

	// Nouvelles sessions (les sessions déjà présentes au démarrage sont
	// mémorisées sans annonce individuelle).
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

// promptNext affiche le prompt de décision pour la demande suivante.
func (c *Console) promptNext() {
	if c.awaiting != nil || len(c.queue) == 0 {
		return
	}
	p := c.queue[0]
	c.queue = c.queue[1:]
	c.awaiting = &p
	c.announcePairing(p)
	c.write("Approuver ? [y/N] ")
}

// handleLine traite une ligne saisie. Si une décision d'appairage est en
// attente, la ligne est interprétée comme la réponse (y/yes/o/oui = approbation,
// tout le reste = refus). Renvoie true pour demander l'arrêt.
func (c *Console) handleLine(line string) (quit bool) {
	line = strings.TrimSpace(line)
	if c.awaiting != nil {
		p := *c.awaiting
		c.awaiting = nil
		approve := isAffirmative(line)
		if err := c.ctrl.Approve(p.ID, approve); err != nil {
			c.printf("Échec de la décision pour %s : %v\n", p.UserCode, err)
		} else if approve {
			c.printf("Approuvé : %s (%s).\n", p.UserCode, p.Origin)
		} else {
			c.printf("Refusé : %s (%s).\n", p.UserCode, p.Origin)
		}
		c.promptNext()
		return false
	}
	return c.handleCommand(line)
}

// handleCommand exécute une commande textuelle.
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
		c.write("Arrêt demandé.\n")
		return true
	default:
		c.printf("Commande inconnue : %q. Tapez « help ».\n", cmd)
	}
	return false
}

// decide approuve ou refuse une demande identifiée par ID ou code utilisateur.
func (c *Console) decide(arg string, approve bool) {
	if arg == "" {
		c.write("Usage : approve|deny <id|code>.\n")
		return
	}
	p, ok := c.findPending(arg)
	if !ok {
		c.printf("Demande introuvable pour %q.\n", arg)
		return
	}
	c.removeFromQueue(p.ID)
	if err := c.ctrl.Approve(p.ID, approve); err != nil {
		c.printf("Échec : %v\n", err)
		return
	}
	if approve {
		c.printf("Approuvé : %s (%s).\n", p.UserCode, p.Origin)
	} else {
		c.printf("Refusé : %s (%s).\n", p.UserCode, p.Origin)
	}
}

// revoke révoque une session par ID (ou préfixe unique), ou toutes.
func (c *Console) revoke(arg string) {
	if arg == "" {
		c.write("Usage : revoke <id|all>.\n")
		return
	}
	if strings.EqualFold(arg, "all") {
		n := 0
		for _, s := range c.ctrl.ListSessions() {
			if c.ctrl.AdminRevoke(s.ID) {
				n++
			}
		}
		c.printf("%d session(s) révoquée(s).\n", n)
		return
	}
	id, ok := c.findSession(arg)
	if !ok {
		c.printf("Session introuvable : %q.\n", arg)
		return
	}
	if c.ctrl.AdminRevoke(id) {
		c.printf("Session révoquée : %s\n", id)
	} else {
		c.printf("Échec de la révocation : %s\n", id)
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

	c.write("\nÉtat du compagnon\n")
	c.printf("  Demandes d'appairage en attente : %d\n", len(pending))
	for _, p := range pending {
		c.printf("    - code %s | %s | expire %s\n", p.UserCode, p.Origin, formatTime(p.ExpiresAt))
	}
	c.printf("  Sessions actives : %d\n", len(sessions))
	for _, s := range sessions {
		c.printf("    - %s | %s | expire %s\n", s.ID, s.Origin, formatTime(s.ExpiresAt))
	}
	c.write("\n")
}

func (c *Console) printHelp() {
	c.write(`Commandes :
  help                 affiche cette aide
  list, status         état, demandes en attente et sessions actives
  approve <id|code>    approuve une demande d'appairage
  deny <id|code>       refuse une demande d'appairage
  revoke <id|all>      révoque une session (ou toutes)
  quit, exit           arrête le compagnon
`)
}

func (c *Console) announcePairing(p auth.Pairing) {
	c.write("\n[Nouvelle demande d'appairage]\n")
	c.printf("  Origine : %s\n", p.Origin)
	c.printf("  Code    : %s\n", p.UserCode)
	c.printf("  Expire  : %s\n", formatTime(p.ExpiresAt))
}

func (c *Console) announceSession(s auth.SessionInfo) {
	c.write("\n[Nouvelle session active]\n")
	c.printf("  ID      : %s\n", s.ID)
	c.printf("  Origine : %s\n", s.Origin)
	c.printf("  Expire  : %s\n", formatTime(s.ExpiresAt))
}

func (c *Console) write(s string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, _ = io.WriteString(c.out, s)
}

func (c *Console) printf(format string, args ...any) {
	c.write(fmt.Sprintf(format, args...))
}

// parseCommand découpe une ligne en commande (minuscules) et argument éventuel.
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
