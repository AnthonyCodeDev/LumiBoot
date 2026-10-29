package security

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"testing"
)

func lookupIPs(ips ...string) LookupFunc {
	return func(_ context.Context, _ string) ([]net.IP, error) {
		out := make([]net.IP, 0, len(ips))
		for _, s := range ips {
			out = append(out, net.ParseIP(s))
		}
		return out, nil
	}
}

func lookupErr() LookupFunc {
	return func(_ context.Context, _ string) ([]net.IP, error) {
		return nil, errors.New("NXDOMAIN")
	}
}

func reasonOf(t *testing.T, err error) byte {
	t.Helper()
	if err == nil {
		t.Fatal("error expected, got nil")
	}
	var be *BlockError
	if !errors.As(err, &be) {
		t.Fatalf("not a BlockError: %v", err)
	}
	return be.Reason
}

func TestForbiddenRanges(t *testing.T) {
	forbidden := []string{
		"127.0.0.1", "::1", // loopback
		"10.0.0.5", "172.16.9.9", "192.168.0.1", "fc00::1", // private
		"169.254.10.20", "fe80::1", // link-local
		"0.0.0.0", "::", // unspecified
		"224.0.0.1", "ff02::1", // multicast
		"255.255.255.255",                                                      // broadcast
		"240.0.0.1",                                                            // reserved
		"0.5.0.1",                                                              // 0.0.0.0/8
		"169.254.169.254", "100.100.100.200", "169.254.170.2", "fd00:ec2::254", // metadata
	}
	for _, ip := range forbidden {
		t.Run(ip, func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs(ip), "example.com", 443, false)
			if reasonOf(t, err) != ReasonDestinationBlocked {
				t.Fatalf("unexpected reason for %s: %v", ip, err)
			}
		})
	}
}

func TestLiteralBlocked(t *testing.T) {
	_, err := ValidateDestination(context.Background(), nil, "10.1.2.3", 80, false)
	if reasonOf(t, err) != ReasonDestinationBlocked {
		t.Fatalf("unexpected reason: %v", err)
	}
}

func TestAllowPrivateNetworks(t *testing.T) {
	allowed := []string{"10.0.0.5", "192.168.1.1", "127.0.0.1", "::1", "fc00::9", "169.254.4.4", "100.64.12.3", "198.18.0.1"}
	for _, ip := range allowed {
		t.Run(ip, func(t *testing.T) {
			got, err := ValidateDestination(context.Background(), lookupIPs(ip), "internal.local", 80, true)
			if err != nil {
				t.Fatalf("private IP refused despite permission: %v", err)
			}
			if !got.Equal(net.ParseIP(ip)) {
				t.Fatalf("unexpected IP returned: %s", got)
			}
		})
	}
}

func TestSharedRangesRequirePrivateNetworkPermission(t *testing.T) {
	for _, ip := range []string{"100.64.12.3", "198.18.0.1"} {
		t.Run(ip, func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs(ip), "internal.example", 80, false)
			if reasonOf(t, err) != ReasonDestinationBlocked {
				t.Fatalf("shared-use address allowed: %v", err)
			}
		})
	}
}

func TestUnspecifiedAndMulticastAlwaysBlocked(t *testing.T) {
	for _, ip := range []string{"0.0.0.0", "::", "224.0.0.1", "ff02::1"} {
		t.Run(ip, func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs(ip), "internal.example", 80, true)
			if reasonOf(t, err) != ReasonDestinationBlocked {
				t.Fatalf("non-destination address allowed: %v", err)
			}
		})
	}
}

func TestMetadataAlwaysBlocked(t *testing.T) {
	blocked := []string{"169.254.169.254", "100.100.100.200", "169.254.170.2", "fd00:ec2::254"}
	for _, ip := range blocked {
		t.Run(ip, func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs(ip), "host.local", 80, true)
			if reasonOf(t, err) != ReasonDestinationBlocked {
				t.Fatalf("metadata allowed anyway: %v", err)
			}
		})
	}
	if _, err := ValidateDestination(context.Background(), lookupIPs("8.8.8.8"), "metadata.google.internal", 80, true); reasonOf(t, err) != ReasonDestinationBlocked {
		t.Fatal("metadata.google.internal accepted")
	}
}

func TestOneBadIPRefusesAll(t *testing.T) {
	_, err := ValidateDestination(context.Background(), lookupIPs("93.184.216.34", "169.254.169.254"), "trap.example", 443, false)
	if reasonOf(t, err) != ReasonDestinationBlocked {
		t.Fatalf("rebinding not detected: %v", err)
	}
}

func TestPublicAllowed(t *testing.T) {
	got, err := ValidateDestination(context.Background(), lookupIPs("93.184.216.34"), "example.com", 443, false)
	if err != nil {
		t.Fatalf("public IP refused: %v", err)
	}
	if got.String() != "93.184.216.34" {
		t.Fatalf("unexpected IP returned: %s", got)
	}
	if got.String() == "example.com" {
		t.Fatal("the validated IP must be returned, not the hostname")
	}
}

func TestTransitionPrefixesAlwaysBlocked(t *testing.T) {
	// Each address either is the transition prefix itself or embeds an IPv4
	// destination (127.0.0.1, 10.0.0.1) that the IPv4 checks would otherwise
	// never see.
	blocked := []string{
		"64:ff9b::7f00:1", // NAT64 -> 127.0.0.1
		"64:ff9b::a00:1",  // NAT64 -> 10.0.0.1
		"64:ff9b:1::1",    // NAT64 local-use prefix
		"2002:7f00:1::",   // 6to4 carrying 127.0.0.1
		"2002:a00:1::1",   // 6to4 carrying 10.0.0.1
		"2001::1",         // Teredo
		"192.0.0.8",       // IETF protocol assignments
	}
	for _, ip := range blocked {
		for _, allowPrivate := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/allowPrivate=%t", ip, allowPrivate), func(t *testing.T) {
				_, err := ValidateDestination(context.Background(), lookupIPs(ip), "internal.example", 443, allowPrivate)
				if reasonOf(t, err) != ReasonDestinationBlocked {
					t.Fatalf("transition address allowed: %v", err)
				}
			})
		}
	}
}

func TestTransitionLiteralBlocked(t *testing.T) {
	// A literal is validated before any DNS lookup.
	_, err := ValidateDestination(context.Background(), nil, "64:ff9b::7f00:1", 443, true)
	if reasonOf(t, err) != ReasonDestinationBlocked {
		t.Fatalf("NAT64 literal allowed: %v", err)
	}
}

func TestBlockedPorts(t *testing.T) {
	for _, port := range []int{25, 137, 139, 445, 1900} {
		t.Run(strconv.Itoa(port), func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs("93.184.216.34"), "example.com", port, false)
			if reasonOf(t, err) != ReasonDestinationBlocked {
				t.Fatalf("sensitive port %d allowed: %v", port, err)
			}
		})
	}
}

func TestBlockedPortsCheckedBeforeDNS(t *testing.T) {
	// The port check must run before the dial, whatever the destination.
	_, err := ValidateDestination(context.Background(), lookupErr(), "example.com", 445, true)
	if reasonOf(t, err) != ReasonDestinationBlocked {
		t.Fatalf("sensitive port allowed before DNS: %v", err)
	}
}

func TestNormalPortsAllowed(t *testing.T) {
	for _, port := range []int{22, 53, 80, 443, 8080, 65535} {
		t.Run(strconv.Itoa(port), func(t *testing.T) {
			if _, err := ValidateDestination(context.Background(), lookupIPs("93.184.216.34"), "example.com", port, false); err != nil {
				t.Fatalf("normal port %d refused: %v", port, err)
			}
		})
	}
}

func TestIPv4MappedLoopbackBlocked(t *testing.T) {
	for _, ip := range []string{"::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.1.1"} {
		t.Run(ip, func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs(ip), "example.com", 443, false)
			if reasonOf(t, err) != ReasonDestinationBlocked {
				t.Fatalf("IPv4-mapped address allowed: %v", err)
			}
		})
	}
	// Metadata stays blocked through the mapped form, even with private networks.
	_, err := ValidateDestination(context.Background(), lookupIPs("::ffff:169.254.169.254"), "example.com", 443, true)
	if reasonOf(t, err) != ReasonDestinationBlocked {
		t.Fatalf("IPv4-mapped metadata allowed: %v", err)
	}
}

func TestPublicIPv6Allowed(t *testing.T) {
	for _, ip := range []string{"2606:4700:4700::1111", "2a00:1450:4007:80e::200e"} {
		t.Run(ip, func(t *testing.T) {
			got, err := ValidateDestination(context.Background(), lookupIPs(ip), "example.com", 443, false)
			if err != nil {
				t.Fatalf("public IPv6 refused: %v", err)
			}
			if !got.Equal(net.ParseIP(ip)) {
				t.Fatalf("unexpected IP returned: %s", got)
			}
		})
	}
}

func TestDNSErrorUnreachable(t *testing.T) {
	_, err := ValidateDestination(context.Background(), lookupErr(), "unknown.invalid", 443, false)
	if reasonOf(t, err) != ReasonHostUnreachable {
		t.Fatalf("unexpected reason: %v", err)
	}
}

func TestInvalidInput(t *testing.T) {
	for name, tc := range map[string]struct {
		host string
		port int
	}{
		"empty host":    {host: "", port: 80},
		"zero port":     {host: "example.com", port: 0},
		"negative port": {host: "example.com", port: -1},
		"huge port":     {host: "example.com", port: 99999},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs("93.184.216.34"), tc.host, tc.port, false)
			if reasonOf(t, err) != ReasonInvalidInfo {
				t.Fatalf("unexpected reason: %v", err)
			}
		})
	}
}
