// Package security validates the destinations requested by the guest after DNS
// resolution and returns the validated IP the caller must dial, never the
// hostname: DNS-rebinding and TOCTOU protection.
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

// BlockError is a typed error carrying the WISP close reason.
type BlockError struct {
	Reason  byte
	Message string
}

func (e *BlockError) Error() string { return e.Message }

// LookupFunc resolves a host name to IP addresses.
type LookupFunc func(ctx context.Context, host string) ([]net.IP, error)

// Cloud metadata endpoints are always blocked, even with AllowPrivateNetworks.
var metadataNets = mustParseCIDRs([]string{
	"169.254.169.254/32",
	"100.100.100.200/32",
	"169.254.170.2/32",
	"fd00:ec2::254/128",
})

var metadataHostnames = []string{
	"metadata.google.internal",
}

var reservedNets = mustParseCIDRs([]string{
	"0.0.0.0/8",
	"240.0.0.0/4",
	"255.255.255.255/32",
})

// These shared-use ranges can route to services on the host's local network,
// even though net.IP.IsPrivate does not classify them as private.
var sharedNets = mustParseCIDRs([]string{
	"100.64.0.0/10", // carrier-grade NAT, including overlay networks
	"198.18.0.0/15", // benchmarking and local network simulators
})

// IPv6 transition prefixes and IETF assignments are blocked unconditionally,
// like multicast or unspecified addresses: each one can carry an IPv4
// destination that the loopback/private checks never see. Behind NAT64,
// 64:ff9b::7f00:1 is routed to 127.0.0.1; 6to4 and Teredo embed the same kind
// of IPv4 address.
var transitionNets = mustParseCIDRs([]string{
	"64:ff9b::/96",   // NAT64 well-known prefix (RFC 6052)
	"64:ff9b:1::/48", // NAT64 local-use prefix (RFC 8215)
	"2002::/16",      // 6to4 (RFC 3056), embeds an IPv4 address
	"2001::/32",      // Teredo (RFC 4380), embeds an IPv4 address
	"192.0.0.0/24",   // IETF protocol assignments (RFC 6890)
})

// blockedPorts lists services that must never be reached through the proxy:
// local infrastructure (NetBIOS/SMB/SSDP) or relay-abused mail submission.
var blockedPorts = map[int]string{
	25:   "SMTP",
	137:  "NetBIOS name service",
	139:  "NetBIOS session service",
	445:  "SMB",
	1900: "SSDP",
}

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

func isMetadataEndpoint(ip net.IP) bool {
	return inNets(ip, metadataNets)
}

// allowPrivate also permits loopback/private/link-local, but never metadata,
// reserved ranges or IPv6 transition prefixes.
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
	if inNets(ip, transitionNets) {
		return true
	}
	if ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || inNets(ip, sharedNets) {
		return !allowPrivate
	}
	if ip.IsPrivate() {
		return !allowPrivate
	}
	return false
}

// ValidateDestination resolves the host, then validates every resolved IP and
// returns the one to dial: the caller must dial that IP, never the hostname.
// Sensitive ports (SMTP, NetBIOS, SMB, SSDP) are refused before the DNS lookup.
func ValidateDestination(ctx context.Context, lookup LookupFunc, host string, port int, allowPrivate bool) (net.IP, error) {
	trimmed := strings.TrimSuffix(strings.TrimSpace(host), ".")
	if trimmed == "" {
		return nil, &BlockError{Reason: ReasonInvalidInfo, Message: "empty host"}
	}
	if port <= 0 || port > 65535 {
		return nil, &BlockError{Reason: ReasonInvalidInfo, Message: fmt.Sprintf("invalid port: %d", port)}
	}
	if service, ok := blockedPorts[port]; ok {
		return nil, &BlockError{
			Reason:  ReasonDestinationBlocked,
			Message: fmt.Sprintf("forbidden port %d (%s)", port, service),
		}
	}
	for _, mh := range metadataHostnames {
		if strings.EqualFold(trimmed, mh) {
			return nil, &BlockError{Reason: ReasonDestinationBlocked, Message: "cloud metadata endpoint forbidden"}
		}
	}

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
	// Every IP is healthy: dial the first one.
	return ips[0], nil
}

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
