// Package config charge et valide la configuration du proxy réseau local : défauts
// sécurisés, fichier JSON, surcharge par variables d'environnement
// LUMIBOOT_PROXY_*, puis validation stricte (dont refus d'écoute
// non-loopback sauf permission explicite).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// Duration est un time.Duration sérialisable en JSON soit comme chaîne
// ("10s", "5m"), soit comme nombre (secondes).
type Duration time.Duration

// UnmarshalJSON accepte une chaîne de durée Go ou un nombre de secondes.
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		v, err := time.ParseDuration(strings.TrimSpace(s))
		if err != nil {
			return fmt.Errorf("config: durée invalide %q", s)
		}
		*d = Duration(v)
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err == nil {
		*d = Duration(time.Duration(f * float64(time.Second)))
		return nil
	}
	return errors.New("config: durée invalide (chaîne ou secondes attendues)")
}

// MarshalJSON sérialise en chaîne de durée Go.
func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

// Std convertit en time.Duration.
func (d Duration) Std() time.Duration { return time.Duration(d) }

// Config est la configuration du proxy réseau local.
type Config struct {
	ListenAddr                   string   `json:"listenAddr"`
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

// ErrNonLoopback signale un refus d'écoute sur une adresse non-loopback.
var ErrNonLoopback = errors.New("config: écoute non-loopback refusée sans allowNonLoopback explicite")

// DefaultOrigins liste les origines autorisées par défaut : production LumiBoot
// et boucles locales de développement (ports courants du monorepo et génériques).
func DefaultOrigins() []string {
	return []string{
		"https://lumiboot.app",
		"https://www.lumiboot.app",
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
	}
}

// Default renvoie la configuration par défaut (sécurisée).
func Default() Config {
	return Config{
		ListenAddr:                   "127.0.0.1:37892",
		AllowedOrigins:               DefaultOrigins(),
		MaxConnections:               64,
		MaxConnectionsPerSession:     16,
		ConnectTimeout:               Duration(10 * time.Second),
		IdleTimeout:                  Duration(60 * time.Second),
		DataTimeout:                  Duration(30 * time.Second),
		InitialBufferPackets:         32,
		MaxDataChunk:                 128 * 1024,
		AllowPrivateNetworks:         false,
		AllowNonLoopback:             false,
		BandwidthLimitBytesPerSecond: 0, // 0 = illimité
		PairingTTL:                   Duration(10 * time.Minute),
		SessionTokenTTL:              Duration(24 * time.Hour),
	}
}

// Load charge la configuration : défauts, puis fichier JSON (si path non vide),
// puis variables d'environnement LUMIBOOT_PROXY_*, puis validation.
// Un fichier inexistant n'est pas une erreur (premier lancement) ; un JSON
// invalide en est une.
func Load(path string) (Config, error) {
	cfg := Default()
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				return Config{}, fmt.Errorf("config: lecture de %s: %w", path, err)
			}
		} else if err := json.Unmarshal(data, &cfg); err != nil {
			return Config{}, fmt.Errorf("config: JSON invalide dans %s: %w", path, err)
		}
	}
	cfg.ApplyEnv()
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// ApplyEnv surcharge la configuration depuis l'environnement.
func (c *Config) ApplyEnv() {
	if v, ok := lookupEnv("LUMIBOOT_PROXY_LISTEN_ADDR"); ok {
		c.ListenAddr = v
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

// Validate contrôle strictement la configuration.
func (c *Config) Validate() error {
	host, portStr, err := net.SplitHostPort(c.ListenAddr)
	if err != nil {
		return fmt.Errorf("config: listenAddr invalide %q: %w", c.ListenAddr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("config: port d'écoute invalide %q", portStr)
	}
	if !c.AllowNonLoopback && !isLoopbackHost(host) {
		return fmt.Errorf("%w: %q", ErrNonLoopback, c.ListenAddr)
	}
	if len(c.AllowedOrigins) == 0 {
		return errors.New("config: allowedOrigins ne doit pas être vide")
	}
	if c.MaxConnections <= 0 {
		return errors.New("config: maxConnections doit être > 0")
	}
	if c.MaxConnectionsPerSession <= 0 {
		return errors.New("config: maxConnectionsPerSession doit être > 0")
	}
	if c.ConnectTimeout.Std() <= 0 {
		return errors.New("config: connectTimeout doit être > 0")
	}
	if c.IdleTimeout.Std() <= 0 {
		return errors.New("config: idleTimeout doit être > 0")
	}
	if c.DataTimeout.Std() <= 0 {
		return errors.New("config: dataTimeout doit être > 0")
	}
	if c.InitialBufferPackets <= 0 {
		return errors.New("config: initialBufferPackets doit être > 0")
	}
	if c.MaxDataChunk <= 0 || c.MaxDataChunk > 4*1024*1024 {
		return errors.New("config: maxDataChunk doit être dans (0, 4 MiB]")
	}
	if c.BandwidthLimitBytesPerSecond < 0 {
		return errors.New("config: bandwidthLimitBytesPerSecond doit être >= 0")
	}
	if c.PairingTTL.Std() <= 0 {
		return errors.New("config: pairingTTL doit être > 0")
	}
	if c.SessionTokenTTL.Std() <= 0 {
		return errors.New("config: sessionTokenTTL doit être > 0")
	}
	return nil
}

// isLoopbackHost indique si un hôte d'écoute est strictement local.
// Un hôte vide (":port", toutes interfaces) n'est PAS loopback.
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
