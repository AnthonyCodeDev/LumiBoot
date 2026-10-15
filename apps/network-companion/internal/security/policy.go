// Package security valide les destinations demandées par l'invitée APRÈS
// résolution DNS et renvoie l'IP validée que l'appelant doit utiliser pour
// composer (jamais le hostname : protection anti DNS-rebinding / TOCTOU).
package security

import (
	"context"
	"fmt"
	"net"
	"strings"
)

// Raisons de fermeture WISP retournées via BlockError.
const (
	ReasonInvalidInfo        = byte(0x41) // entrée invalide
	ReasonHostUnreachable    = byte(0x42) // DNS ou routage impossible
	ReasonDestinationBlocked = byte(0x48) // destination interdite par la politique
)

// BlockError est une erreur typée portant la raison de fermeture WISP à
// renvoyer au client.
type BlockError struct {
	Reason  byte
	Message string
}

// Error implémente error.
func (e *BlockError) Error() string { return e.Message }

// LookupFunc résout un nom d'hôte en adresses IP.
type LookupFunc func(ctx context.Context, host string) ([]net.IP, error)

// metadataNets liste les endpoints de métadonnées cloud, TOUJOURS bloqués,
// même avec AllowPrivateNetworks (risque d'exfiltration d'identifiants).
var metadataNets = mustParseCIDRs([]string{
	"169.254.169.254/32", // AWS / GCP / Azure / Oracle
	"100.100.100.200/32", // Alibaba Cloud
	"169.254.170.2/32",   // ECS (identifiants de tâche)
	"fd00:ec2::254/128",  // AWS IPv6
})

// metadataHostnames liste les noms d'endpoints cloud bloqués par nom.
var metadataHostnames = []string{
	"metadata.google.internal",
}

// reservedNets liste les plages toujours interdites.
var reservedNets = mustParseCIDRs([]string{
	"0.0.0.0/8",          // « ce réseau » (RFC 1122)
	"240.0.0.0/4",        // réservé / expérimental
	"255.255.255.255/32", // broadcast limité
})

func mustParseCIDRs(cidrs []string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic("security: CIDR invalide: " + c)
		}
		out = append(out, n)
	}
	return out
}

func inNets(ip net.IP, nets []*net.IPNet) bool {
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// isMetadataEndpoint indique un endpoint de métadonnées cloud.
func isMetadataEndpoint(ip net.IP) bool {
	return inNets(ip, metadataNets)
}

// forbiddenIP applique la politique à une IP déjà résolue.
// allowPrivate autorise loopback/privé/link-local (permission explicite),
// mais JAMAIS les métadonnées cloud ni les plages réservées.
func forbiddenIP(ip net.IP, allowPrivate bool) bool {
	if ip == nil {
		return true
	}
	if isMetadataEndpoint(ip) {
		return true
	}
	if inNets(ip, reservedNets) {
		return true
	}
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return !allowPrivate
	}
	if ip.IsPrivate() {
		return !allowPrivate
	}
	return false
}

// ValidateDestination résout host puis valide chaque IP résolue.
// Si UNE SEULE IP résolue est interdite, la destination entière est refusée
// (anti DNS-rebinding : le client ne doit pas pouvoir forcer une IP saine
// puis être redirigé vers une IP interne).
// En cas de succès, renvoie l'IP validée à composer : l'appelant DOIT
// composer cette IP, jamais le hostname (anti TOCTOU).
func ValidateDestination(ctx context.Context, lookup LookupFunc, host string, port int, allowPrivate bool) (net.IP, error) {
	trimmed := strings.TrimSuffix(strings.TrimSpace(host), ".")
	if trimmed == "" {
		return nil, &BlockError{Reason: ReasonInvalidInfo, Message: "hôte vide"}
	}
	if port <= 0 || port > 65535 {
		return nil, &BlockError{Reason: ReasonInvalidInfo, Message: fmt.Sprintf("port invalide: %d", port)}
	}
	for _, mh := range metadataHostnames {
		if strings.EqualFold(trimmed, mh) {
			return nil, &BlockError{Reason: ReasonDestinationBlocked, Message: "endpoint de métadonnées cloud interdit"}
		}
	}

	// IP littérale : pas de DNS, validation directe.
	if literal := net.ParseIP(trimmed); literal != nil {
		if forbiddenIP(literal, allowPrivate) {
			return nil, &BlockError{Reason: ReasonDestinationBlocked, Message: fmt.Sprintf("IP interdite: %s", literal)}
		}
		return literal, nil
	}

	if lookup == nil {
		lookup = defaultLookup
	}
	ips, err := lookup(ctx, trimmed)
	if err != nil {
		return nil, &BlockError{Reason: ReasonHostUnreachable, Message: fmt.Sprintf("résolution DNS impossible pour %q: %v", trimmed, err)}
	}
	if len(ips) == 0 {
		return nil, &BlockError{Reason: ReasonHostUnreachable, Message: fmt.Sprintf("aucune adresse pour %q", trimmed)}
	}
	for _, ip := range ips {
		if forbiddenIP(ip, allowPrivate) {
			return nil, &BlockError{
				Reason:  ReasonDestinationBlocked,
				Message: fmt.Sprintf("destination interdite pour %q (résout vers %s)", trimmed, ip),
			}
		}
	}
	// Toutes les IP sont saines : composer la première (déjà validée).
	return ips[0], nil
}

// defaultLookup est la résolution DNS standard de la machine.
func defaultLookup(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	return ips, nil
}
