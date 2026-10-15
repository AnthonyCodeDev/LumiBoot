package security

import (
	"context"
	"errors"
	"net"
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
		t.Fatal("erreur attendue, obtenu nil")
	}
	var be *BlockError
	if !errors.As(err, &be) {
		t.Fatalf("pas une BlockError: %v", err)
	}
	return be.Reason
}

func TestForbiddenRanges(t *testing.T) {
	forbidden := []string{
		"127.0.0.1", "::1", // loopback
		"10.0.0.5", "172.16.9.9", "192.168.0.1", "fc00::1", // privés
		"169.254.10.20", "fe80::1", // link-local
		"0.0.0.0", "::", // non spécifiées
		"224.0.0.1", "ff02::1", // multicast
		"255.255.255.255",                                                      // broadcast
		"240.0.0.1",                                                            // réservée
		"0.5.0.1",                                                              // 0.0.0.0/8
		"169.254.169.254", "100.100.100.200", "169.254.170.2", "fd00:ec2::254", // métadonnées
	}
	for _, ip := range forbidden {
		t.Run(ip, func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs(ip), "example.com", 443, false)
			if reasonOf(t, err) != ReasonDestinationBlocked {
				t.Fatalf("raison inattendue pour %s: %v", ip, err)
			}
		})
	}
}

func TestLiteralBlocked(t *testing.T) {
	// IP littérale interdite, sans DNS.
	_, err := ValidateDestination(context.Background(), nil, "10.1.2.3", 80, false)
	if reasonOf(t, err) != ReasonDestinationBlocked {
		t.Fatalf("raison inattendue: %v", err)
	}
}

func TestAllowPrivateNetworks(t *testing.T) {
	allowed := []string{"10.0.0.5", "192.168.1.1", "127.0.0.1", "::1", "fc00::9", "169.254.4.4"}
	for _, ip := range allowed {
		t.Run(ip, func(t *testing.T) {
			got, err := ValidateDestination(context.Background(), lookupIPs(ip), "interne.local", 80, true)
			if err != nil {
				t.Fatalf("IP privée refusée malgré permission: %v", err)
			}
			if !got.Equal(net.ParseIP(ip)) {
				t.Fatalf("IP renvoyée inattendue: %s", got)
			}
		})
	}
}

func TestMetadataAlwaysBlocked(t *testing.T) {
	blocked := []string{"169.254.169.254", "100.100.100.200", "169.254.170.2", "fd00:ec2::254"}
	for _, ip := range blocked {
		t.Run(ip, func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs(ip), "hote.local", 80, true)
			if reasonOf(t, err) != ReasonDestinationBlocked {
				t.Fatalf("métadonnées autorisées malgré tout: %v", err)
			}
		})
	}
	if _, err := ValidateDestination(context.Background(), lookupIPs("8.8.8.8"), "metadata.google.internal", 80, true); reasonOf(t, err) != ReasonDestinationBlocked {
		t.Fatal("metadata.google.internal accepté")
	}
}

func TestOneBadIPRefusesAll(t *testing.T) {
	// Anti DNS-rebinding : une seule IP interdite parmi des saines refuse tout.
	_, err := ValidateDestination(context.Background(), lookupIPs("93.184.216.34", "169.254.169.254"), "piege.example", 443, false)
	if reasonOf(t, err) != ReasonDestinationBlocked {
		t.Fatalf("rebinding non détecté: %v", err)
	}
}

func TestPublicAllowed(t *testing.T) {
	got, err := ValidateDestination(context.Background(), lookupIPs("93.184.216.34"), "example.com", 443, false)
	if err != nil {
		t.Fatalf("IP publique refusée: %v", err)
	}
	if got.String() != "93.184.216.34" {
		t.Fatalf("IP renvoyée inattendue: %s", got)
	}
	// L'appelant doit composer l'IP validée, pas le hostname.
	if got.String() == "example.com" {
		t.Fatal("l'IP validée doit être renvoyée, pas le hostname")
	}
}

func TestDNSErrorUnreachable(t *testing.T) {
	_, err := ValidateDestination(context.Background(), lookupErr(), "inconnu.invalid", 443, false)
	if reasonOf(t, err) != ReasonHostUnreachable {
		t.Fatalf("raison inattendue: %v", err)
	}
}

func TestInvalidInput(t *testing.T) {
	for name, tc := range map[string]struct {
		host string
		port int
	}{
		"hôte vide":    {host: "", port: 80},
		"port zéro":    {host: "example.com", port: 0},
		"port négatif": {host: "example.com", port: -1},
		"port énorme":  {host: "example.com", port: 99999},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ValidateDestination(context.Background(), lookupIPs("93.184.216.34"), tc.host, tc.port, false)
			if reasonOf(t, err) != ReasonInvalidInfo {
				t.Fatalf("raison inattendue: %v", err)
			}
		})
	}
}
