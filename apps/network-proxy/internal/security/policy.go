// Package security validates the destinations requested by the guest AFTER DNS
// resolution and returns the validated IP the caller must dial (never the
// hostname: DNS-rebinding / TOCTOU protection).
package security

import (
	"context"
	"fmt"
	"net"
	"strings"
)

// WISP close reasons returned through BlockError.
const (
	ReasonInvalidInfo        = byte(0x41) // invalid input
	ReasonHostUnreachable    = byte(0x42) // DNS or routing impossible
	ReasonDestinationBlocked = byte(0x48) // destination forbidden by policy
)

// BlockError is a typed error carrying the WISP close reason to send back to
// the client.
type BlockError struct {
	Reason  byte
	Message string
}

// Error implements error.
func (e *BlockError) Error() string { return e.Message }

// LookupFunc resolves a host name to IP addresses.
type LookupFunc func(ctx context.Context, host string) ([]net.IP, error)

// metadataNets lists the cloud metadata endpoints, ALWAYS blocked, even with
// AllowPrivateNetworks (risk of credential exfiltration).
var metadataNets = mustParseCIDRs([]string{
	"169.254.169.254/32", // AWS / GCP / Azure / Oracle
	"100.100.100.200/32", // Alibaba Cloud
	"169.254.170.2/32",   // ECS (task credentials)
	"fd00:ec2::254/128",  // AWS IPv6
})

// metadataHostnames lists the cloud endpoint names blocked by name.
var metadataHostnames = []string{
	"metadata.google.internal",
}

// reservedNets lists the always-forbidden ranges.
var reservedNets = mustParseCIDRs([]string{
	"0.0.0.0/8",          // "this network" (RFC 1122)
	"240.0.0.0/4",        // reserved / experimental
	"255.255.255.255/32", // limited broadcast
})

func mustParseCIDRs(cidrs []string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic("security: invalid CIDR: " + c)
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

// isMetadataEndpoint reports a cloud metadata endpoint.
func isMetadataEndpoint(ip net.IP) bool {
	return inNets(ip, metadataNets)
}

// forbiddenIP applies the policy to an already resolved IP.
// allowPrivate allows loopback/private/link-local (explicit permission), but
// NEVER cloud metadata or reserved ranges.
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

// ValidateDestination resolves host then validates every resolved IP.
// If a SINGLE resolved IP is forbidden, the whole destination is refused
// (anti DNS-rebinding: the client must not be able to force a healthy IP and
// then be redirected to an internal IP).
// On success, returns the validated IP to dial: the caller MUST dial that IP,
// never the hostname (anti TOCTOU).
func ValidateDestination(ctx context.Context, lookup LookupFunc, host string, port int, allowPrivate bool) (net.IP, error) {
	trimmed := strings.TrimSuffix(strings.TrimSpace(host), ".")
	if trimmed == "" {
		return nil, &BlockError{Reason: ReasonInvalidInfo, Message: "empty host"}
	}
	if port <= 0 || port > 65535 {
		return nil, &BlockError{Reason: ReasonInvalidInfo, Message: fmt.Sprintf("invalid port: %d", port)}
	}
	for _, mh := range metadataHostnames {
		if strings.EqualFold(trimmed, mh) {
			return nil, &BlockError{Reason: ReasonDestinationBlocked, Message: "cloud metadata endpoint forbidden"}
		}
	}

	// Literal IP: no DNS, direct validation.
	if literal := net.ParseIP(trimmed); literal != nil {
		if forbiddenIP(literal, allowPrivate) {
			return nil, &BlockError{Reason: ReasonDestinationBlocked, Message: fmt.Sprintf("forbidden IP: %s", literal)}
		}
		return literal, nil
	}

	if lookup == nil {
		lookup = defaultLookup
	}
	ips, err := lookup(ctx, trimmed)
	if err != nil {
		return nil, &BlockError{Reason: ReasonHostUnreachable, Message: fmt.Sprintf("DNS resolution failed for %q: %v", trimmed, err)}
	}
	if len(ips) == 0 {
		return nil, &BlockError{Reason: ReasonHostUnreachable, Message: fmt.Sprintf("no address for %q", trimmed)}
	}
	for _, ip := range ips {
		if forbiddenIP(ip, allowPrivate) {
			return nil, &BlockError{
				Reason:  ReasonDestinationBlocked,
				Message: fmt.Sprintf("forbidden destination for %q (resolves to %s)", trimmed, ip),
			}
		}
	}
	// All IPs are healthy: dial the first one (already validated).
	return ips[0], nil
}

// defaultLookup is the machine's standard DNS resolution.
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
