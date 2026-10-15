package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultValid(t *testing.T) {
	cfg := Default()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("config par défaut invalide: %v", err)
	}
	if cfg.ListenAddr != "127.0.0.1:37892" {
		t.Fatalf("listenAddr par défaut inattendu: %s", cfg.ListenAddr)
	}
	if cfg.AllowNonLoopback || cfg.AllowPrivateNetworks {
		t.Fatal("les permissions sensibles doivent être refusées par défaut")
	}
}

func TestLoadMissingFile(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("fichier absent devrait donner les défauts: %v", err)
	}
	if cfg.ListenAddr != Default().ListenAddr {
		t.Fatalf("défauts non appliqués: %+v", cfg)
	}
}

func TestLoadJSONFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	content := `{
		"listenAddr": "127.0.0.1:39999",
		"connectTimeout": "5s",
		"idleTimeout": 120,
		"maxConnections": 10,
		"allowPrivateNetworks": true
	}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("chargement: %v", err)
	}
	if cfg.ListenAddr != "127.0.0.1:39999" {
		t.Fatalf("listenAddr: %s", cfg.ListenAddr)
	}
	if cfg.ConnectTimeout.Std().Seconds() != 5 {
		t.Fatalf("connectTimeout: %v", cfg.ConnectTimeout.Std())
	}
	if cfg.IdleTimeout.Std().Seconds() != 120 {
		t.Fatalf("idleTimeout (secondes numériques): %v", cfg.IdleTimeout.Std())
	}
	if cfg.MaxConnections != 10 || !cfg.AllowPrivateNetworks {
		t.Fatalf("champs: %+v", cfg)
	}
}

func TestLoadInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("{invalide"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("JSON invalide accepté")
	}
}

func TestEnvOverride(t *testing.T) {
	t.Setenv("LUMIBOOT_PROXY_LISTEN_ADDR", "127.0.0.1:37777")
	t.Setenv("LUMIBOOT_PROXY_MAX_CONNECTIONS", "8")
	t.Setenv("LUMIBOOT_PROXY_ALLOW_PRIVATE_NETWORKS", "true")
	t.Setenv("LUMIBOOT_PROXY_CONNECT_TIMEOUT", "3s")
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	if cfg.ListenAddr != "127.0.0.1:37777" || cfg.MaxConnections != 8 {
		t.Fatalf("surcharge env ignorée: %+v", cfg)
	}
	if !cfg.AllowPrivateNetworks || cfg.ConnectTimeout.Std().Seconds() != 3 {
		t.Fatalf("surcharge env ignorée: %+v", cfg)
	}
}

func TestRefuseNonLoopback(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:37892", ":37892", "192.168.1.10:37892", "[::]:37892", "example.com:37892"} {
		cfg := Default()
		cfg.ListenAddr = addr
		if err := cfg.Validate(); err == nil {
			t.Fatalf("écoute %q acceptée sans permission", addr)
		}
	}
}

func TestAllowNonLoopbackExplicit(t *testing.T) {
	cfg := Default()
	cfg.ListenAddr = "0.0.0.0:37892"
	cfg.AllowNonLoopback = true
	if err := cfg.Validate(); err != nil {
		t.Fatalf("écoute explicite refusée: %v", err)
	}
}

func TestLoopbackFormsAccepted(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:37892", "127.0.0.2:1", "localhost:8080", "[::1]:37892"} {
		cfg := Default()
		cfg.ListenAddr = addr
		if err := cfg.Validate(); err != nil {
			t.Fatalf("écoute loopback %q refusée: %v", addr, err)
		}
	}
}

func TestValidationRejects(t *testing.T) {
	mutate := func(f func(*Config)) Config {
		cfg := Default()
		f(&cfg)
		return cfg
	}
	cases := map[string]Config{
		"port zéro":               mutate(func(c *Config) { c.ListenAddr = "127.0.0.1:0" }),
		"adresse malformée":       mutate(func(c *Config) { c.ListenAddr = "nawak" }),
		"origines vides":          mutate(func(c *Config) { c.AllowedOrigins = nil }),
		"maxConnections zéro":     mutate(func(c *Config) { c.MaxConnections = 0 }),
		"quota session zéro":      mutate(func(c *Config) { c.MaxConnectionsPerSession = 0 }),
		"timeout zéro":            mutate(func(c *Config) { c.ConnectTimeout = 0 }),
		"buffer zéro":             mutate(func(c *Config) { c.InitialBufferPackets = 0 }),
		"chunk trop grand":        mutate(func(c *Config) { c.MaxDataChunk = 8 * 1024 * 1024 }),
		"bande passante négative": mutate(func(c *Config) { c.BandwidthLimitBytesPerSecond = -1 }),
		"pairingTTL zéro":         mutate(func(c *Config) { c.PairingTTL = 0 }),
	}
	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			if err := cfg.Validate(); err == nil {
				t.Fatal("config invalide acceptée")
			}
		})
	}
}
