// Package testutil holds the deployment-dependent values the Go tests need:
// loopback origins, the public domain and WebSocket URLs. It is only imported
// from `_test.go` files, never from production code.
//
// Every value comes from the environment, so changing `WEB_DEV_PORT`,
// `E2E_PORT` or `LUMIBOOT_DOMAIN` in the root `.env` keeps the tests aligned
// with the application instead of duplicating the defaults everywhere.
package testutil

import (
	"net"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// Built-in defaults, applied when the environment leaves a variable empty. They
// mirror the defaults documented in the root `.env.example`.
const (
	defaultTestHost   = "127.0.0.1"
	defaultTestPort   = "5200"
	defaultDomain     = "lumiboot.example.com"
	defaultWebDevHost = "127.0.0.1"
	defaultWebDevPort = "5173"
	hostileOrigin     = "http://evil.example"
	otherOrigin       = "https://other.example"
)

// ExampleHost and ExampleIP are the generic fixture values shared by the tests
// that need a name or an address without any deployment meaning.
const (
	// ExampleHost is a reserved example domain (`RFC 2606`).
	ExampleHost = "example.com"
	// ExampleIP is the address that same example domain resolves to.
	ExampleIP = "93.184.216.34"
)

// envKeyPattern accepts the dotenv keys the Node helper also accepts.
var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// doubleQuoteEscapes mirrors `scripts/lib/load-env.mjs`: only these five
// sequences are decoded inside double quotes.
var doubleQuoteEscapes = strings.NewReplacer(
	`\n`, "\n",
	`\r`, "\r",
	`\t`, "\t",
	`\"`, `"`,
	`\\`, `\`,
)

// init loads the repository `.env`, if any. The file is optional: a bare
// checkout, a build without sources (`-trimpath`) or an unreadable file must
// never fail a test.
func init() {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return
	}
	applyEnvFile(filepath.Join(repoRoot(filepath.Dir(file)), ".env"))
}

// Env returns the trimmed environment value of `key`, or `fallback` when the
// variable is absent or blank.
func Env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

// TestOrigin is the origin of the application served by `pnpm preview`, used by
// the Go tests as their default allowed origin.
func TestOrigin() string {
	return "http://" + Env("E2E_HOST", defaultTestHost) + ":" + Env("E2E_PORT", defaultTestPort)
}

// AltOrigin is a second allowed origin, a production-looking one, for
// cross-origin isolation tests.
func AltOrigin() string {
	return "https://" + Env("LUMIBOOT_DOMAIN", defaultDomain)
}

// WebDevOrigin is the Vite development server origin.
func WebDevOrigin() string {
	return "http://" + Env("WEB_DEV_HOST", defaultWebDevHost) + ":" + Env("WEB_DEV_PORT", defaultWebDevPort)
}

// HostileOrigin is never in any allowlist: it proves a hostile `Origin` header
// is refused.
func HostileOrigin() string { return hostileOrigin }

// OtherOrigin is a second, distinct origin for isolation tests.
func OtherOrigin() string { return otherOrigin }

// WispURL builds the WISP WebSocket URL of a test server, upgrading `http` to
// `ws` and `https` to `wss`. The token is appended verbatim, exactly like the
// application advertises it; an empty token leaves the query string out.
func WispURL(server *httptest.Server, token string) string {
	base := server.URL
	if strings.HasPrefix(base, "https://") {
		base = "wss://" + strings.TrimPrefix(base, "https://")
	} else {
		base = "ws://" + strings.TrimPrefix(base, "http://")
	}
	if token == "" {
		return base + "/wisp/"
	}
	return base + "/wisp/?token=" + token
}

// WithPort returns `origin` with its port replaced, keeping the scheme, the
// host and any path. It is used by the rejection tests that need a near-miss
// origin (a neighbouring port).
func WithPort(origin string, port int) string {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return origin
	}
	parsed.Host = net.JoinHostPort(parsed.Hostname(), strconv.Itoa(port))
	return parsed.String()
}

// WithScheme returns `origin` with its scheme replaced, keeping everything
// else. It is used by the rejection tests that need an unsupported scheme.
func WithScheme(origin, scheme string) string {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return origin
	}
	parsed.Scheme = scheme
	return parsed.String()
}

// repoRoot walks up from `dir` looking for the repository root, identified by
// the root `.env.example` and the Go module of this app. It falls back to the
// known depth of this package (`apps/network-proxy/internal/testutil`).
func repoRoot(dir string) string {
	for candidate := dir; ; {
		if isRepoRoot(candidate) {
			return candidate
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			break
		}
		candidate = parent
	}
	return filepath.Join(dir, "..", "..", "..", "..")
}

// isRepoRoot reports whether `dir` looks like the LumiBoot repository root.
func isRepoRoot(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, ".env.example")); err != nil {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, "apps", "network-proxy", "go.mod"))
	return err == nil
}

// applyEnvFile parses a dotenv file and merges it into the process environment.
// A variable already present in `os.Environ()` always wins, exactly like
// `scripts/lib/load-env.mjs`: the shell, then the file. It returns the parsed
// values (nil for a missing file) so callers can inspect them.
func applyEnvFile(path string) map[string]string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	parsed := parseEnv(string(data))
	for key, value := range parsed {
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		_ = os.Setenv(key, value)
	}
	return parsed
}

// parseEnv parses dotenv-style text. Supported syntax, as in the Node helper:
// `KEY=VALUE`, single or double quotes, `#` comments, blank lines and an inline
// ` # comment` on an unquoted value. There is no variable expansion.
func parseEnv(text string) map[string]string {
	parsed := make(map[string]string)
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		separator := strings.Index(trimmed, "=")
		if separator <= 0 {
			continue
		}
		key := strings.TrimSpace(trimmed[:separator])
		if !envKeyPattern.MatchString(key) {
			continue
		}
		parsed[key] = parseEnvValue(trimmed[separator+1:])
	}
	return parsed
}

// parseEnvValue decodes one dotenv value.
func parseEnvValue(raw string) string {
	value := strings.TrimSpace(raw)
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		return doubleQuoteEscapes.Replace(value[1 : len(value)-1])
	}
	if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
		return value[1 : len(value)-1]
	}
	return trimInlineComment(value)
}

// trimInlineComment drops a trailing `# comment` that follows whitespace, the
// way the Node loader does; a `#` glued to the value is kept.
func trimInlineComment(value string) string {
	for i := 1; i < len(value); i++ {
		if value[i] == '#' && (value[i-1] == ' ' || value[i-1] == '\t') {
			return strings.TrimSpace(value[:i])
		}
	}
	return strings.TrimSpace(value)
}
