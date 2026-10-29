package config

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// webDevOrigin is the default Vite dev origin, derived from the production
// constants so that a port change only has to be made in one place.
//
// The config tests deliberately do not import `internal/testutil`: that package
// loads the root `.env`, whose `LUMIBOOT_PROXY_ALLOWED_ORIGINS` would override
// the JSON and environment fixtures asserted below.
func webDevOrigin() string {
	// loopbackOrigins lists the IP first, then the `localhost` spelling.
	return loopbackOrigins(defaultWebDevPort)[1]
}

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

// TestProdOriginsFollowDomain: the default production allowlist follows
// `LUMIBOOT_DOMAIN`, so a deployment only has to edit one variable. An
// unusable value falls back to the documented example domain instead of
// producing an empty or malformed origin; the authoritative allowlist remains
// `LUMIBOOT_PROXY_ALLOWED_ORIGINS`.
func TestProdOriginsFollowDomain(t *testing.T) {
	defaultOrigins := []string{"https://" + defaultDomain, "https://www." + defaultDomain}

	t.Setenv("LUMIBOOT_DOMAIN", "")
	if got := ProdOrigins(); !slices.Equal(got, defaultOrigins) {
		t.Fatalf("absent domain: %v, want %v", got, defaultOrigins)
	}

	t.Setenv("LUMIBOOT_DOMAIN", "staging.example.org")
	want := []string{"https://staging.example.org", "https://www.staging.example.org"}
	if got := ProdOrigins(); !slices.Equal(got, want) {
		t.Fatalf("configured domain: %v, want %v", got, want)
	}
	if got := OriginsForEnvironment(EnvProduction); !slices.Equal(got, want) {
		t.Fatalf("production allowlist must follow the domain: %v", got)
	}
	if !slices.Contains(DevOrigins(), want[0]) {
		t.Fatalf("development allowlist must extend the production one: %v", DevOrigins())
	}

	// A pasted origin is trimmed down to its bare authority.
	t.Setenv("LUMIBOOT_DOMAIN", "  https://Pasted.Example/  ")
	if got, want := ProdOrigins(), []string{"https://Pasted.Example", "https://www.Pasted.Example"}; !slices.Equal(got, want) {
		t.Fatalf("origin-shaped domain: %v, want %v", got, want)
	}

	for _, invalid := range []string{"", "  ", "not a domain", "ftp://example.org", "https://", "/"} {
		t.Run("invalid="+invalid, func(t *testing.T) {
			t.Setenv("LUMIBOOT_DOMAIN", invalid)
			if got := ProdOrigins(); !slices.Equal(got, defaultOrigins) {
				t.Fatalf("invalid domain %q must fall back to the default: %v, want %v", invalid, got, defaultOrigins)
			}
		})
	}
}

func TestDevOriginsFollowConfiguredPorts(t *testing.T) {
	// The default allowlist is derived from the environment: start from none.
	t.Setenv("WEB_DEV_PORT", "")
	t.Setenv("E2E_PORT", "")

	baseline := DevOrigins()
	for _, want := range append(loopbackOrigins(defaultWebDevPort), loopbackOrigins(defaultE2EPort)...) {
		if !slices.Contains(baseline, want) {
			t.Fatalf("default development origins must keep %q: %v", want, baseline)
		}
	}
	for _, forbidden := range loopbackOrigins(5300) {
		if slices.Contains(baseline, forbidden) {
			t.Fatalf("absent port variables must leave the list untouched: %v", baseline)
		}
	}

	t.Setenv("WEB_DEV_PORT", "5300")
	t.Setenv("E2E_PORT", "5301")
	custom := DevOrigins()
	for _, want := range append(loopbackOrigins(5300), loopbackOrigins(5301)...) {
		if !slices.Contains(custom, want) {
			t.Fatalf("origin %q missing from the development allowlist: %v", want, custom)
		}
	}
	seen := make(map[string]struct{}, len(custom))
	for _, origin := range custom {
		if _, duplicate := seen[origin]; duplicate {
			t.Fatalf("duplicate origin %q in the development allowlist", origin)
		}
		seen[origin] = struct{}{}
	}

	// Configured ports equal to a default must not duplicate their origins.
	t.Setenv("WEB_DEV_PORT", strconv.Itoa(defaultWebDevPort))
	t.Setenv("E2E_PORT", strconv.Itoa(defaultE2EPort))
	if got := DevOrigins(); len(got) != len(baseline) {
		t.Fatalf("a default port must not add origins: %v", got)
	}

	// Production never widens, whatever the port variables say.
	if got := OriginsForEnvironment(EnvProduction); !slices.Equal(got, ProdOrigins()) {
		t.Fatalf("production allowlist changed with the port variables: %v", got)
	}
}

func TestDevOriginsIgnoreInvalidPorts(t *testing.T) {
	cases := []struct {
		key   string
		value string
	}{
		{"WEB_DEV_PORT", "abc"},
		{"E2E_PORT", "abc"},
		{"WEB_DEV_PORT", "70000"},
		{"E2E_PORT", "70000"},
		{"WEB_DEV_PORT", "0"},
	}
	for _, tc := range cases {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			t.Setenv("WEB_DEV_PORT", "")
			t.Setenv("E2E_PORT", "")
			baseline := DevOrigins()
			t.Setenv(tc.key, tc.value)
			if got := DevOrigins(); !slices.Equal(got, baseline) {
				t.Fatalf("invalid %s=%q must be ignored, got %v", tc.key, tc.value, got)
			}
		})
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
		if origin == webDevOrigin() {
			found = true
		}
	}
	if !found {
		t.Fatalf("development allowlist expected, got: %v", cfg.AllowedOrigins)
	}
}

func TestProductionRejectsLocalhostOriginWithoutOptIn(t *testing.T) {
	cfg := Default()
	cfg.AllowedOrigins = append(cfg.AllowedOrigins, webDevOrigin())
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
	cfg.AllowedOrigins = []string{webDevOrigin()}
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
	content := fmt.Sprintf(`{
		"environment": "development",
		"allowedOrigins": [%q]
	}`, webDevOrigin())
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
	content := fmt.Sprintf(`{"allowedOrigins": [%q]}`, webDevOrigin())
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

func TestLoadRejectsUnknownField(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	// A typo must not be ignored: it would leave allowPrivateNetworks at false.
	content := `{"allowPrivateNetwork": true}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load(path)
	if err == nil {
		t.Fatal("unknown config field accepted")
	}
	if !strings.Contains(err.Error(), "allowPrivateNetwork") {
		t.Fatalf("error must name the unknown field, got: %v", err)
	}
}

func TestLoadRejectsTrailingData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	content := `{"maxConnections": 8}{"maxConnections": 9}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("trailing JSON data accepted")
	}
}

func TestLoadAllowsExampleShape(t *testing.T) {
	// Every documented field must still be accepted by the strict decoder.
	path := filepath.Join(t.TempDir(), "config.json")
	content := fmt.Sprintf(`{
		"listenAddr": "127.0.0.1:37892",
		"environment": "production",
		"allowLocalOrigins": false,
		"allowedOrigins": [%q],
		"maxConnections": 64,
		"maxConnectionsPerSession": 16,
		"connectTimeout": "10s",
		"idleTimeout": "60s",
		"dataTimeout": 30,
		"initialBufferPackets": 32,
		"maxDataChunk": 131072,
		"allowPrivateNetworks": false,
		"allowNonLoopback": false,
		"bandwidthLimitBytesPerSecond": 0,
		"pairingTTL": "10m",
		"sessionTokenTTL": "24h"
	}`, ProdOrigins()[0])
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("documented config refused: %v", err)
	}
	full := Default()
	if cfg.MaxConnections != full.MaxConnections || cfg.MaxDataChunk != full.MaxDataChunk {
		t.Fatalf("parsed config differs: %+v", cfg)
	}
}

func TestEnvInvalidValueFailsLoad(t *testing.T) {
	cases := map[string]struct {
		key   string
		value string
	}{
		"non-numeric maxConnections": {"LUMIBOOT_PROXY_MAX_CONNECTIONS", "abc"},
		"non-bool allowPrivate":      {"LUMIBOOT_PROXY_ALLOW_PRIVATE_NETWORKS", "maybe"},
		"non-duration idle timeout":  {"LUMIBOOT_PROXY_IDLE_TIMEOUT", "later"},
		"non-numeric data chunk":     {"LUMIBOOT_PROXY_MAX_DATA_CHUNK", "10x"},
		"non-numeric bandwidth":      {"LUMIBOOT_PROXY_BANDWIDTH_LIMIT_BPS", "fast"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Setenv(tc.key, tc.value)
			if _, err := Load(""); err == nil {
				t.Fatalf("%s=%q silently accepted", tc.key, tc.value)
			} else if !strings.Contains(err.Error(), tc.key) {
				t.Fatalf("error must name %s, got: %v", tc.key, err)
			}
		})
	}
}

func TestEnvInvalidValueReachesValidate(t *testing.T) {
	// A syntactically valid but out-of-range value still fails loudly.
	t.Setenv("LUMIBOOT_PROXY_MAX_CONNECTIONS", "100000")
	if _, err := Load(""); err == nil {
		t.Fatal("out-of-range maxConnections accepted")
	}
}

func TestBoundsAcceptedAtLimits(t *testing.T) {
	cfg := Default()
	cfg.MaxConnections = maxConnectionsMin
	cfg.InitialBufferPackets = initialBufferPacketsMin
	cfg.MaxDataChunk = maxDataChunkMin
	if err := cfg.Validate(); err != nil {
		t.Fatalf("lower bounds refused: %v", err)
	}
	cfg.MaxConnections = maxConnectionsMax
	cfg.InitialBufferPackets = initialBufferPacketsMax
	cfg.MaxDataChunk = maxDataChunkMax
	if err := cfg.Validate(); err != nil {
		t.Fatalf("upper bounds refused: %v", err)
	}
}

func TestBoundsRejectedOutsideRange(t *testing.T) {
	mutate := func(f func(*Config)) Config {
		cfg := Default()
		f(&cfg)
		return cfg
	}
	cases := map[string]Config{
		"negative maxConnections": mutate(func(c *Config) { c.MaxConnections = -1 }),
		"maxConnections too big":  mutate(func(c *Config) { c.MaxConnections = maxConnectionsMax + 1 }),
		"negative buffer":         mutate(func(c *Config) { c.InitialBufferPackets = -1 }),
		"buffer too big":          mutate(func(c *Config) { c.InitialBufferPackets = initialBufferPacketsMax + 1 }),
		"negative chunk":          mutate(func(c *Config) { c.MaxDataChunk = -1 }),
		"chunk above 1 MiB":       mutate(func(c *Config) { c.MaxDataChunk = maxDataChunkMax + 1 }),
	}
	for name, cfg := range cases {
		t.Run(name, func(t *testing.T) {
			if err := cfg.Validate(); err == nil {
				t.Fatal("out-of-bounds value accepted")
			}
		})
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
		"malformed origin":   mutate(func(c *Config) { c.AllowedOrigins = []string{"not-an-origin"} }),
		"unsupported origin": mutate(func(c *Config) { c.AllowedOrigins = []string{"ftp://example.com"} }),
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
