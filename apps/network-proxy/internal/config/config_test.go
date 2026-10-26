package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultValid(t *testing.T) {
	cfg := Default()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("default config invalid: %v", err)
	}
	if cfg.ListenAddr != "127.0.0.1:37892" {
		t.Fatalf("unexpected default listenAddr: %s", cfg.ListenAddr)
	}
	if cfg.AllowNonLoopback || cfg.AllowPrivateNetworks {
		t.Fatal("sensitive permissions must be denied by default")
	}
	if cfg.Environment != EnvProduction {
		t.Fatalf("default environment: %q", cfg.Environment)
	}
	for _, origin := range cfg.AllowedOrigins {
		if isLoopbackOrigin(origin) {
			t.Fatalf("loopback origin %q forbidden by default in production", origin)
		}
	}
}

func TestDefaultOriginsAreProductionOnly(t *testing.T) {
	for _, origin := range ProdOrigins() {
		if isLoopbackOrigin(origin) {
			t.Fatalf("ProdOrigins contains a local origin: %q", origin)
		}
	}
	if len(DevOrigins()) <= len(ProdOrigins()) {
		t.Fatal("DevOrigins must extend ProdOrigins with local loops")
	}
	if got := DefaultOrigins(); len(got) != len(ProdOrigins()) {
		t.Fatalf("DefaultOrigins must remain the production allowlist: %v", got)
	}
}

func TestDevelopmentEnvironmentExpandsOrigins(t *testing.T) {
	t.Setenv("LUMIBOOT_PROXY_ENV", "development")
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("load in development: %v", err)
	}
	if cfg.Environment != EnvDevelopment {
		t.Fatalf("environment: %q", cfg.Environment)
	}
	found := false
	for _, origin := range cfg.AllowedOrigins {
		if origin == "http://localhost:5173" {
			found = true
		}
	}
	if !found {
		t.Fatalf("development allowlist expected, got: %v", cfg.AllowedOrigins)
	}
}

func TestProductionRejectsLocalhostOriginWithoutOptIn(t *testing.T) {
	cfg := Default()
	cfg.AllowedOrigins = append(cfg.AllowedOrigins, "http://localhost:5173")
	if err := cfg.Validate(); err == nil {
		t.Fatal("local origin accepted in production without allowLocalOrigins")
	}
	cfg.AllowLocalOrigins = true
	if err := cfg.Validate(); err != nil {
		t.Fatalf("explicit local pairing refused: %v", err)
	}
}

func TestDevelopmentAllowsLocalhostOrigin(t *testing.T) {
	cfg := DefaultFor(EnvDevelopment)
	cfg.AllowedOrigins = []string{"http://localhost:5173"}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("development local origin refused: %v", err)
	}
}

func TestEnvironmentEnvInvalidIsProduction(t *testing.T) {
	t.Setenv("LUMIBOOT_PROXY_ENV", "staging-invalid")
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Environment != EnvProduction {
		t.Fatalf("unknown environment must fall back to production: %q", cfg.Environment)
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
		t.Fatalf("load development JSON: %v", err)
	}
	if cfg.Environment != EnvDevelopment {
		t.Fatalf("JSON environment: %q", cfg.Environment)
	}
}

func TestProductionJSONRejectsLocalhostOrigin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	content := `{"allowedOrigins": ["http://localhost:5173"]}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("local origin in production accepted without allowLocalOrigins")
	}
}

func TestLoadMissingFile(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.json"))
	if err != nil {
		t.Fatalf("a missing file should yield defaults: %v", err)
	}
	if cfg.ListenAddr != Default().ListenAddr {
		t.Fatalf("defaults not applied: %+v", cfg)
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
		t.Fatalf("load: %v", err)
	}
	if cfg.ListenAddr != "127.0.0.1:39999" {
		t.Fatalf("listenAddr: %s", cfg.ListenAddr)
	}
	if cfg.ConnectTimeout.Std().Seconds() != 5 {
		t.Fatalf("connectTimeout: %v", cfg.ConnectTimeout.Std())
	}
	if cfg.IdleTimeout.Std().Seconds() != 120 {
		t.Fatalf("idleTimeout (numeric seconds): %v", cfg.IdleTimeout.Std())
	}
	if cfg.MaxConnections != 10 || !cfg.AllowPrivateNetworks {
		t.Fatalf("fields: %+v", cfg)
	}
}

func TestLoadInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("{invalid"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("invalid JSON accepted")
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
		t.Fatalf("env override ignored: %+v", cfg)
	}
	if !cfg.AllowPrivateNetworks || cfg.ConnectTimeout.Std().Seconds() != 3 {
		t.Fatalf("env override ignored: %+v", cfg)
	}
}

func TestRefuseNonLoopback(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:37892", ":37892", "192.168.1.10:37892", "[::]:37892", "example.com:37892"} {
		cfg := Default()
		cfg.ListenAddr = addr
		if err := cfg.Validate(); err == nil {
			t.Fatalf("listen %q accepted without permission", addr)
		}
	}
}

func TestAllowNonLoopbackExplicit(t *testing.T) {
	cfg := Default()
	cfg.ListenAddr = "0.0.0.0:37892"
	cfg.AllowNonLoopback = true
	if err := cfg.Validate(); err != nil {
		t.Fatalf("explicit listen refused: %v", err)
	}
}

func TestLoopbackFormsAccepted(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:37892", "127.0.0.2:1", "localhost:8080", "[::1]:37892"} {
		cfg := Default()
		cfg.ListenAddr = addr
		if err := cfg.Validate(); err != nil {
			t.Fatalf("loopback listen %q refused: %v", addr, err)
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
		"zero port":          mutate(func(c *Config) { c.ListenAddr = "127.0.0.1:0" }),
		"malformed address":  mutate(func(c *Config) { c.ListenAddr = "invalid" }),
		"empty origins":      mutate(func(c *Config) { c.AllowedOrigins = nil }),
		"zero maxConns":      mutate(func(c *Config) { c.MaxConnections = 0 }),
		"zero session quota": mutate(func(c *Config) { c.MaxConnectionsPerSession = 0 }),
		"zero timeout":       mutate(func(c *Config) { c.ConnectTimeout = 0 }),
		"zero buffer":        mutate(func(c *Config) { c.InitialBufferPackets = 0 }),
		"chunk too large":    mutate(func(c *Config) { c.MaxDataChunk = 8 * 1024 * 1024 }),
		"negative bandwidth": mutate(func(c *Config) { c.BandwidthLimitBytesPerSecond = -1 }),
		"zero pairingTTL":    mutate(func(c *Config) { c.PairingTTL = 0 }),
	}
	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			if err := cfg.Validate(); err == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
}
