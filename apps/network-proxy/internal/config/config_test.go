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
	if cfg.Environment != EnvProduction {
		t.Fatalf("environnement par défaut: %q", cfg.Environment)
	}
	for _, origin := range cfg.AllowedOrigins {
		if isLoopbackOrigin(origin) {
			t.Fatalf("origine loopback %q interdite par défaut en production", origin)
		}
	}
}

func TestDefaultOriginsAreProductionOnly(t *testing.T) {
	for _, origin := range ProdOrigins() {
		if isLoopbackOrigin(origin) {
			t.Fatalf("ProdOrigins contient une origine locale: %q", origin)
		}
	}
	if len(DevOrigins()) <= len(ProdOrigins()) {
		t.Fatal("DevOrigins doit élargir ProdOrigins aux boucles locales")
	}
	if got := DefaultOrigins(); len(got) != len(ProdOrigins()) {
		t.Fatalf("DefaultOrigins doit rester l'allowlist de production: %v", got)
	}
}

func TestDevelopmentEnvironmentExpandsOrigins(t *testing.T) {
	t.Setenv("LUMIBOOT_PROXY_ENV", "development")
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("chargement en développement: %v", err)
	}
	if cfg.Environment != EnvDevelopment {
		t.Fatalf("environnement: %q", cfg.Environment)
	}
	found := false
	for _, origin := range cfg.AllowedOrigins {
		if origin == "http://localhost:5173" {
			found = true
		}
	}
	if !found {
		t.Fatalf("allowlist de développement attendue, obtenu: %v", cfg.AllowedOrigins)
	}
}

func TestProductionRejectsLocalhostOriginWithoutOptIn(t *testing.T) {
	cfg := Default()
	cfg.AllowedOrigins = append(cfg.AllowedOrigins, "http://localhost:5173")
	if err := cfg.Validate(); err == nil {
		t.Fatal("origine locale acceptée en production sans allowLocalOrigins")
	}
	cfg.AllowLocalOrigins = true
	if err := cfg.Validate(); err != nil {
		t.Fatalf("appairage local explicite refusé: %v", err)
	}
}

func TestDevelopmentAllowsLocalhostOrigin(t *testing.T) {
	cfg := DefaultFor(EnvDevelopment)
	cfg.AllowedOrigins = []string{"http://localhost:5173"}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("origine locale de développement refusée: %v", err)
	}
}

func TestEnvironmentEnvInvalidIsProduction(t *testing.T) {
	t.Setenv("LUMIBOOT_PROXY_ENV", "staging-nawak")
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("chargement: %v", err)
	}
	if cfg.Environment != EnvProduction {
		t.Fatalf("environnement inconnu doit retomber sur production: %q", cfg.Environment)
	}
}

func TestLoadJSONEnvironmentDevelopment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	content := `{
		"environment": "development",
		"allowedOrigins": ["http://localhost:5173"]
	}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("chargement JSON développement: %v", err)
	}
	if cfg.Environment != EnvDevelopment {
		t.Fatalf("environnement JSON: %q", cfg.Environment)
	}
}

func TestProductionJSONRejectsLocalhostOrigin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	content := `{"allowedOrigins": ["http://localhost:5173"]}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("origine locale en production acceptée sans allowLocalOrigins")
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
