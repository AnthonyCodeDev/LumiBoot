// Package config loads and validates the local network proxy configuration:
// safe defaults, then the JSON file, then LUMIBOOT_PROXY_* environment overrides.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Configuration bounds. A value outside its range is a mistake (typically a
// unit mix-up or a typo) and must be refused rather than silently accepted.
const (
	maxConnectionsMin       = 1
	maxConnectionsMax       = 1024
	initialBufferPacketsMin = 1
	initialBufferPacketsMax = 256
	maxDataChunkMin         = 1
	maxDataChunkMax         = 1024 * 1024 // 1 MiB
)

// Environment selects the default origin allowlist; the default is always
// `production`, widening it is an explicit choice.
type Environment string

const (
	// EnvProduction accepts no generic loopback origin without opt-in.
	EnvProduction Environment = "production"
	// EnvDevelopment widens the allowlist to the monorepo loopback ports.
	EnvDevelopment Environment = "development"
)

// Duration is a time.Duration serializable as a string or a number of seconds.
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

type Config struct {
	ListenAddr string `json:"listenAddr"`
	// Environment selects the default allowlist; empty means production.
	Environment Environment `json:"environment"`
	// AllowLocalOrigins allows loopback origins in production.
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

// Built-in defaults. They mirror the values documented in the root
// `.env.example`; a deployment only has to override the environment variables.
const (
	// defaultDomain is the example production domain used when
	// `LUMIBOOT_DOMAIN` is absent or unusable.
	defaultDomain = "lumiboot.example.com"
	// defaultWebDevPort is the Vite dev server port; `WEB_DEV_PORT` widens it.
	defaultWebDevPort = 5173
	// defaultE2EPort is the Playwright preview port; `E2E_PORT` widens it.
	defaultE2EPort = 5200
)

// ProdOrigins lists the default production origins, derived from
// `LUMIBOOT_DOMAIN` (default `lumiboot.example.com`): the apex domain and its
// `www` alias.
//
// This list is only a default for a local deployment. The authoritative,
// explicit allowlist remains `LUMIBOOT_PROXY_ALLOWED_ORIGINS`, and a local
// deployment that serves another host must either set that variable or enable
// `allowLocalOrigins`.
func ProdOrigins() []string {
	domain := domainFromEnv()
	return []string{
		"https://" + domain,
		"https://www." + domain,
	}
}

// domainFromEnv reads `LUMIBOOT_DOMAIN`, trimmed of any scheme, path, query
// fragment and surrounding space. An empty or unusable value falls back to
// `defaultDomain`: a typo must not produce an empty or malformed allowlist.
func domainFromEnv() string {
	raw, ok := lookupEnv("LUMIBOOT_DOMAIN")
	if !ok {
		return defaultDomain
	}
	domain := normalizeDomain(raw)
	if domain == "" {
		return defaultDomain
	}
	return domain
}

// normalizeDomain turns an origin or host into a bare `host[:port]`, or returns
// an empty string when the value cannot be a domain.
func normalizeDomain(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	// Accept a pasted origin, but only with the schemes the proxy serves.
	if i := strings.Index(value, "://"); i >= 0 {
		scheme := strings.ToLower(value[:i])
		if scheme != "http" && scheme != "https" {
			return ""
		}
		value = value[i+3:]
	}
	// Drop any path, query or fragment: only the authority is kept.
	if i := strings.IndexAny(value, "/?#"); i >= 0 {
		value = value[:i]
	}
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, " \t\r\n") {
		return ""
	}
	return value
}

// loopbackOrigins lists both loopback spellings of one port, in the order the
// allowlist has always used (IP first, then hostname).
func loopbackOrigins(port int) []string {
	return []string{
		fmt.Sprintf("http://127.0.0.1:%d", port),
		fmt.Sprintf("http://localhost:%d", port),
	}
}

// devPortFromEnv reads an optional TCP port from `WEB_DEV_PORT` / `E2E_PORT`.
// A value outside 1..65535 is ignored: the default allowlist already covers the
// monorepo ports, so a malformed override must not break development pairing.
func devPortFromEnv(key string) (int, bool) {
	raw, ok := lookupEnv(key)
	if !ok {
		return 0, false
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, false
	}
	return port, true
}

// DevOrigins adds the monorepo loopback ports; never used in production.
//
// `WEB_DEV_PORT` and `E2E_PORT` from the root `.env` widen the list, so changing
// either port keeps the development pairing working. Duplicates and invalid
// values are ignored; an absent variable leaves the defaults untouched.
func DevOrigins() []string {
	origins := append(ProdOrigins(), loopbackOrigins(defaultWebDevPort)...)
	origins = append(origins, loopbackOrigins(defaultE2EPort)...)
	origins = append(origins,
		"http://127.0.0.1:3000",
		"http://localhost:3000",
		"http://127.0.0.1:4173",
		"http://localhost:4173",
		"http://127.0.0.1:8080",
		"http://localhost:8080",
	)
	seen := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		seen[origin] = struct{}{}
	}
	for _, key := range []string{"WEB_DEV_PORT", "E2E_PORT"} {
		port, ok := devPortFromEnv(key)
		if !ok {
			continue
		}
		for _, origin := range loopbackOrigins(port) {
			if _, duplicate := seen[origin]; duplicate {
				continue
			}
			seen[origin] = struct{}{}
			origins = append(origins, origin)
		}
	}
	return origins
}

// OriginsForEnvironment returns the default allowlist for an environment.
func OriginsForEnvironment(env Environment) []string {
	if env == EnvDevelopment {
		return DevOrigins()
	}
	return ProdOrigins()
}

// DefaultOrigins is a production alias kept for compatibility.
func DefaultOrigins() []string {
	return ProdOrigins()
}

// Default returns the production configuration.
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

// environmentFromEnv reads LUMIBOOT_PROXY_ENV; anything but dev means production.
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

// Load applies defaults, then the JSON file, then the environment, then
// validation. A missing file is not an error.
func Load(path string) (Config, error) {
	cfg := DefaultFor(environmentFromEnv())
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				return Config{}, fmt.Errorf("config: reading %s: %w", path, err)
			}
		} else if err := decodeStrict(data, &cfg); err != nil {
			return Config{}, fmt.Errorf("config: invalid JSON in %s: %w", path, err)
		}
	}
	if err := cfg.ApplyEnv(); err != nil {
		return Config{}, err
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// decodeStrict decodes a single JSON object and refuses unknown fields and
// trailing data: a typo such as "allowPrivateNetwork" must fail loudly instead
// of leaving a sensitive permission at its default.
func decodeStrict(data []byte, dst *Config) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return errors.New("unexpected trailing data after the JSON object")
	}
	return nil
}

// ApplyEnv overrides the configuration from the environment. A variable that is
// set but cannot be parsed is an error: a typo must never be ignored silently.
func (c *Config) ApplyEnv() error {
	if v, ok, err := envString("LUMIBOOT_PROXY_LISTEN_ADDR"); err != nil {
		return err
	} else if ok {
		c.ListenAddr = v
	}
	if _, ok := lookupEnv("LUMIBOOT_PROXY_ENV"); ok {
		c.Environment = environmentFromEnv()
	}
	if v, ok, err := envBool("LUMIBOOT_PROXY_ALLOW_LOCAL_ORIGINS"); err != nil {
		return err
	} else if ok {
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
	if v, ok, err := envInt("LUMIBOOT_PROXY_MAX_CONNECTIONS"); err != nil {
		return err
	} else if ok {
		c.MaxConnections = v
	}
	if v, ok, err := envInt("LUMIBOOT_PROXY_MAX_CONNECTIONS_PER_SESSION"); err != nil {
		return err
	} else if ok {
		c.MaxConnectionsPerSession = v
	}
	if v, ok, err := envDuration("LUMIBOOT_PROXY_CONNECT_TIMEOUT"); err != nil {
		return err
	} else if ok {
		c.ConnectTimeout = Duration(v)
	}
	if v, ok, err := envDuration("LUMIBOOT_PROXY_IDLE_TIMEOUT"); err != nil {
		return err
	} else if ok {
		c.IdleTimeout = Duration(v)
	}
	if v, ok, err := envDuration("LUMIBOOT_PROXY_DATA_TIMEOUT"); err != nil {
		return err
	} else if ok {
		c.DataTimeout = Duration(v)
	}
	if v, ok, err := envInt("LUMIBOOT_PROXY_INITIAL_BUFFER_PACKETS"); err != nil {
		return err
	} else if ok {
		c.InitialBufferPackets = v
	}
	if v, ok, err := envInt("LUMIBOOT_PROXY_MAX_DATA_CHUNK"); err != nil {
		return err
	} else if ok {
		c.MaxDataChunk = v
	}
	if v, ok, err := envBool("LUMIBOOT_PROXY_ALLOW_PRIVATE_NETWORKS"); err != nil {
		return err
	} else if ok {
		c.AllowPrivateNetworks = v
	}
	if v, ok, err := envBool("LUMIBOOT_PROXY_ALLOW_NON_LOOPBACK"); err != nil {
		return err
	} else if ok {
		c.AllowNonLoopback = v
	}
	if v, ok, err := envInt64("LUMIBOOT_PROXY_BANDWIDTH_LIMIT_BPS"); err != nil {
		return err
	} else if ok {
		c.BandwidthLimitBytesPerSecond = v
	}
	if v, ok, err := envDuration("LUMIBOOT_PROXY_PAIRING_TTL"); err != nil {
		return err
	} else if ok {
		c.PairingTTL = Duration(v)
	}
	if v, ok, err := envDuration("LUMIBOOT_PROXY_SESSION_TOKEN_TTL"); err != nil {
		return err
	} else if ok {
		c.SessionTokenTTL = Duration(v)
	}
	return nil
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
	for _, origin := range c.AllowedOrigins {
		parsed, err := url.Parse(origin)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
			return fmt.Errorf("config: invalid allowed origin %q", origin)
		}
	}
	// In production a loopback origin needs `allowLocalOrigins`.
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
	if c.MaxConnections < maxConnectionsMin || c.MaxConnections > maxConnectionsMax {
		return fmt.Errorf(
			"config: maxConnections must be in [%d, %d], got %d",
			maxConnectionsMin, maxConnectionsMax, c.MaxConnections,
		)
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
	if c.InitialBufferPackets < initialBufferPacketsMin || c.InitialBufferPackets > initialBufferPacketsMax {
		return fmt.Errorf(
			"config: initialBufferPackets must be in [%d, %d], got %d",
			initialBufferPacketsMin, initialBufferPacketsMax, c.InitialBufferPackets,
		)
	}
	if c.MaxDataChunk < maxDataChunkMin || c.MaxDataChunk > maxDataChunkMax {
		return fmt.Errorf(
			"config: maxDataChunk must be in [%d, %d] bytes (1 MiB max), got %d",
			maxDataChunkMin, maxDataChunkMax, c.MaxDataChunk,
		)
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

// isLoopbackHost reports whether a listen host is strictly local; an empty host
// is not loopback.
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

// isLoopbackOrigin reports whether an HTTP or HTTPS origin targets a loopback
// address.
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

// envValue parses one environment variable. It reports (value, present, error):
// a malformed value is an error carrying the variable name, never a silent
// fallback to the default.
func envValue[T any](key string, parse func(string) (T, error)) (T, bool, error) {
	var zero T
	raw, ok := lookupEnv(key)
	if !ok {
		return zero, false, nil
	}
	v, err := parse(raw)
	if err != nil {
		return zero, false, fmt.Errorf("config: invalid %s=%q: %w", key, raw, err)
	}
	return v, true, nil
}

func envString(key string) (string, bool, error) {
	return envValue(key, func(s string) (string, error) { return s, nil })
}

func envInt(key string) (int, bool, error) {
	return envValue(key, strconv.Atoi)
}

func envInt64(key string) (int64, bool, error) {
	return envValue(key, func(s string) (int64, error) { return strconv.ParseInt(s, 10, 64) })
}

func envBool(key string) (bool, bool, error) {
	return envValue(key, strconv.ParseBool)
}

func envDuration(key string) (time.Duration, bool, error) {
	return envValue(key, parseDuration)
}

// parseDuration accepts a Go duration string or a number of seconds.
func parseDuration(s string) (time.Duration, error) {
	if d, err := time.ParseDuration(s); err == nil {
		return d, nil
	}
	if secs, err := strconv.ParseFloat(s, 64); err == nil {
		return time.Duration(secs * float64(time.Second)), nil
	}
	return 0, fmt.Errorf("invalid duration %q (10s or seconds expected)", s)
}
