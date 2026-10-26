// Package config loads and validates the local network proxy configuration:
// safe defaults, JSON file, LUMIBOOT_PROXY_* environment overrides, then
// strict validation (including refusing a non-loopback listen address unless
// explicitly allowed).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Environment identifies the deployment profile that determines the default
// origin allowlist. The default value is always `production`: widening it to
// local loops is an EXPLICIT choice.
type Environment string

const (
	// EnvProduction: strict allowlist, LumiBoot production only. No generic
	// `localhost` origin is accepted without opt-in.
	EnvProduction Environment = "production"
	// EnvDevelopment: allowlist widened to the monorepo local loops
	// (ports 5173/5200/3000/4173/8080).
	EnvDevelopment Environment = "development"
)

// Duration is a time.Duration serializable to JSON either as a string
// ("10s", "5m") or as a number (seconds).
type Duration time.Duration

// UnmarshalJSON accepts a Go duration string or a number of seconds.
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		v, err := time.ParseDuration(strings.TrimSpace(s))
		if err != nil {
			return fmt.Errorf("config: invalid duration %q", s)
		}
		*d = Duration(v)
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err == nil {
		*d = Duration(time.Duration(f * float64(time.Second)))
		return nil
	}
	return errors.New("config: invalid duration (string or seconds expected)")
}

// MarshalJSON serializes to a Go duration string.
func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

// Std converts to a time.Duration.
func (d Duration) Std() time.Duration { return time.Duration(d) }

// Config is the local network proxy configuration.
type Config struct {
	ListenAddr string `json:"listenAddr"`
	// Environment selects the default allowlist (strict production or local
	// development). Empty = production.
	Environment Environment `json:"environment"`
	// AllowLocalOrigins explicitly allows loopback origins in production, only
	// when local pairing is actually needed.
	AllowLocalOrigins            bool     `json:"allowLocalOrigins"`
	AllowedOrigins               []string `json:"allowedOrigins"`
	MaxConnections               int      `json:"maxConnections"`
	MaxConnectionsPerSession     int      `json:"maxConnectionsPerSession"`
	ConnectTimeout               Duration `json:"connectTimeout"`
	IdleTimeout                  Duration `json:"idleTimeout"`
	DataTimeout                  Duration `json:"dataTimeout"`
	InitialBufferPackets         int      `json:"initialBufferPackets"`
	MaxDataChunk                 int      `json:"maxDataChunk"`
	AllowPrivateNetworks         bool     `json:"allowPrivateNetworks"`
	AllowNonLoopback             bool     `json:"allowNonLoopback"`
	BandwidthLimitBytesPerSecond int64    `json:"bandwidthLimitBytesPerSecond"`
	PairingTTL                   Duration `json:"pairingTTL"`
	SessionTokenTTL              Duration `json:"sessionTokenTTL"`
}

// ErrNonLoopback reports a refused listen on a non-loopback address.
var ErrNonLoopback = errors.New("config: non-loopback listen refused without explicit allowNonLoopback")

// ProdOrigins lists the LumiBoot PRODUCTION origins. No generic local loop is
// included: a local deployment (UI served from the machine) must explicitly add
// its origin or enable `allowLocalOrigins`.
func ProdOrigins() []string {
	return []string{
		"https://lumiboot.app",
		"https://www.lumiboot.app",
	}
}

// DevOrigins lists the DEVELOPMENT origins: production plus the usual monorepo
// local loops (dev port 5173, E2E port 5200, various preview ports). Never used
// in production.
func DevOrigins() []string {
	return append(ProdOrigins(),
		"http://127.0.0.1:5173",
		"http://localhost:5173",
		"http://127.0.0.1:5200",
		"http://localhost:5200",
		"http://127.0.0.1:3000",
		"http://localhost:3000",
		"http://127.0.0.1:4173",
		"http://localhost:4173",
		"http://127.0.0.1:8080",
		"http://localhost:8080",
	)
}

// OriginsForEnvironment returns the default allowlist for an environment.
func OriginsForEnvironment(env Environment) []string {
	if env == EnvDevelopment {
		return DevOrigins()
	}
	return ProdOrigins()
}

// DefaultOrigins is the historical production alias: strict allowlist. Kept for
// compatibility; prefer {@link ProdOrigins}.
func DefaultOrigins() []string {
	return ProdOrigins()
}

// Default returns the default configuration (secure, production).
func Default() Config {
	return DefaultFor(EnvProduction)
}

// DefaultFor returns the default configuration for a given environment.
func DefaultFor(env Environment) Config {
	return Config{
		ListenAddr:                   "127.0.0.1:37892",
		Environment:                  env,
		AllowLocalOrigins:            false,
		AllowedOrigins:               OriginsForEnvironment(env),
		MaxConnections:               64,
		MaxConnectionsPerSession:     16,
		ConnectTimeout:               Duration(10 * time.Second),
		IdleTimeout:                  Duration(60 * time.Second),
		DataTimeout:                  Duration(30 * time.Second),
		InitialBufferPackets:         32,
		MaxDataChunk:                 128 * 1024,
		AllowPrivateNetworks:         false,
		AllowNonLoopback:             false,
		BandwidthLimitBytesPerSecond: 0, // 0 = unlimited
		PairingTTL:                   Duration(10 * time.Minute),
		SessionTokenTTL:              Duration(24 * time.Hour),
	}
}

// environmentFromEnv reads LUMIBOOT_PROXY_ENV. Any value other than
// "development"/"dev" (or absence) is treated as production.
func environmentFromEnv() Environment {
	v, ok := lookupEnv("LUMIBOOT_PROXY_ENV")
	if !ok {
		return EnvProduction
	}
	switch strings.ToLower(v) {
	case "development", "dev":
		return EnvDevelopment
	default:
		return EnvProduction
	}
}

// Load loads the configuration: defaults (allowlist by environment), then JSON
// file (if path is not empty), then LUMIBOOT_PROXY_* environment variables, then
// validation.
// A missing file is not an error (first launch); invalid JSON is.
func Load(path string) (Config, error) {
	cfg := DefaultFor(environmentFromEnv())
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				return Config{}, fmt.Errorf("config: reading %s: %w", path, err)
			}
		} else if err := json.Unmarshal(data, &cfg); err != nil {
			return Config{}, fmt.Errorf("config: invalid JSON in %s: %w", path, err)
		}
	}
	cfg.ApplyEnv()
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// ApplyEnv overrides the configuration from the environment.
func (c *Config) ApplyEnv() {
	if v, ok := lookupEnv("LUMIBOOT_PROXY_LISTEN_ADDR"); ok {
		c.ListenAddr = v
	}
	if _, ok := lookupEnv("LUMIBOOT_PROXY_ENV"); ok {
		c.Environment = environmentFromEnv()
	}
	if v, ok := lookupEnvBool("LUMIBOOT_PROXY_ALLOW_LOCAL_ORIGINS"); ok {
		c.AllowLocalOrigins = v
	}
	if v, ok := lookupEnv("LUMIBOOT_PROXY_ALLOWED_ORIGINS"); ok {
		var origins []string
		for _, o := range strings.Split(v, ",") {
			if o = strings.TrimSpace(o); o != "" {
				origins = append(origins, o)
			}
		}
		c.AllowedOrigins = origins
	}
	if v, ok := lookupEnvInt("LUMIBOOT_PROXY_MAX_CONNECTIONS"); ok {
		c.MaxConnections = v
	}
	if v, ok := lookupEnvInt("LUMIBOOT_PROXY_MAX_CONNECTIONS_PER_SESSION"); ok {
		c.MaxConnectionsPerSession = v
	}
	if v, ok := lookupEnvDuration("LUMIBOOT_PROXY_CONNECT_TIMEOUT"); ok {
		c.ConnectTimeout = Duration(v)
	}
	if v, ok := lookupEnvDuration("LUMIBOOT_PROXY_IDLE_TIMEOUT"); ok {
		c.IdleTimeout = Duration(v)
	}
	if v, ok := lookupEnvDuration("LUMIBOOT_PROXY_DATA_TIMEOUT"); ok {
		c.DataTimeout = Duration(v)
	}
	if v, ok := lookupEnvInt("LUMIBOOT_PROXY_INITIAL_BUFFER_PACKETS"); ok {
		c.InitialBufferPackets = v
	}
	if v, ok := lookupEnvInt("LUMIBOOT_PROXY_MAX_DATA_CHUNK"); ok {
		c.MaxDataChunk = v
	}
	if v, ok := lookupEnvBool("LUMIBOOT_PROXY_ALLOW_PRIVATE_NETWORKS"); ok {
		c.AllowPrivateNetworks = v
	}
	if v, ok := lookupEnvBool("LUMIBOOT_PROXY_ALLOW_NON_LOOPBACK"); ok {
		c.AllowNonLoopback = v
	}
	if v, ok := lookupEnvInt64("LUMIBOOT_PROXY_BANDWIDTH_LIMIT_BPS"); ok {
		c.BandwidthLimitBytesPerSecond = v
	}
	if v, ok := lookupEnvDuration("LUMIBOOT_PROXY_PAIRING_TTL"); ok {
		c.PairingTTL = Duration(v)
	}
	if v, ok := lookupEnvDuration("LUMIBOOT_PROXY_SESSION_TOKEN_TTL"); ok {
		c.SessionTokenTTL = Duration(v)
	}
}

// Validate strictly checks the configuration.
func (c *Config) Validate() error {
	host, portStr, err := net.SplitHostPort(c.ListenAddr)
	if err != nil {
		return fmt.Errorf("config: invalid listenAddr %q: %w", c.ListenAddr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("config: invalid listen port %q", portStr)
	}
	if !c.AllowNonLoopback && !isLoopbackHost(host) {
		return fmt.Errorf("%w: %q", ErrNonLoopback, c.ListenAddr)
	}
	if len(c.AllowedOrigins) == 0 {
		return errors.New("config: allowedOrigins must not be empty")
	}
	// DEV/PROD segregation: in production, a generic loopback origin is only
	// accepted when local pairing is explicitly needed (`allowLocalOrigins`) or
	// when the environment is `development`.
	if c.Environment != EnvDevelopment && !c.AllowLocalOrigins {
		for _, origin := range c.AllowedOrigins {
			if isLoopbackOrigin(origin) {
				return fmt.Errorf(
					"config: local origin %q refused in production: enable allowLocalOrigins (explicit local pairing) or LUMIBOOT_PROXY_ENV=development",
					origin,
				)
			}
		}
	}
	if c.MaxConnections <= 0 {
		return errors.New("config: maxConnections must be > 0")
	}
	if c.MaxConnectionsPerSession <= 0 {
		return errors.New("config: maxConnectionsPerSession must be > 0")
	}
	if c.ConnectTimeout.Std() <= 0 {
		return errors.New("config: connectTimeout must be > 0")
	}
	if c.IdleTimeout.Std() <= 0 {
		return errors.New("config: idleTimeout must be > 0")
	}
	if c.DataTimeout.Std() <= 0 {
		return errors.New("config: dataTimeout must be > 0")
	}
	if c.InitialBufferPackets <= 0 {
		return errors.New("config: initialBufferPackets must be > 0")
	}
	if c.MaxDataChunk <= 0 || c.MaxDataChunk > 4*1024*1024 {
		return errors.New("config: maxDataChunk must be in (0, 4 MiB]")
	}
	if c.BandwidthLimitBytesPerSecond < 0 {
		return errors.New("config: bandwidthLimitBytesPerSecond must be >= 0")
	}
	if c.PairingTTL.Std() <= 0 {
		return errors.New("config: pairingTTL must be > 0")
	}
	if c.SessionTokenTTL.Std() <= 0 {
		return errors.New("config: sessionTokenTTL must be > 0")
	}
	return nil
}

// isLoopbackHost reports whether a listen host is strictly local.
// An empty host (":port", all interfaces) is NOT loopback.
func isLoopbackHost(host string) bool {
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return false
	}
	return ip.IsLoopback()
}

// isLoopbackOrigin reports whether an HTTP(S) origin targets a loopback address
// (`http://localhost:5173`, `http://127.0.0.1:5200`, `https://[::1]:8443`...).
// An unparsable origin is not considered loopback (fail safe in validation: it
// is left to exact matching during authentication).
func isLoopbackOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return isLoopbackHost(parsed.Hostname())
}

func lookupEnv(key string) (string, bool) {
	v, ok := os.LookupEnv(key)
	if !ok || strings.TrimSpace(v) == "" {
		return "", false
	}
	return strings.TrimSpace(v), true
}

func lookupEnvInt(key string) (int, bool) {
	v, ok := lookupEnv(key)
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, false
	}
	return n, true
}

func lookupEnvInt64(key string) (int64, bool) {
	v, ok := lookupEnv(key)
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func lookupEnvBool(key string) (bool, bool) {
	v, ok := lookupEnv(key)
	if !ok {
		return false, false
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, false
	}
	return b, true
}

func lookupEnvDuration(key string) (time.Duration, bool) {
	v, ok := lookupEnv(key)
	if !ok {
		return 0, false
	}
	if d, err := time.ParseDuration(v); err == nil {
		return d, true
	}
	if secs, err := strconv.ParseFloat(v, 64); err == nil {
		return time.Duration(secs * float64(time.Second)), true
	}
	return 0, false
}
