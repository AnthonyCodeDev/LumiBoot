package testutil

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseEnv(t *testing.T) {
	text := strings.Join([]string{
		"# a comment",
		"",
		"PLAIN=value",
		"SPACED =  padded value  ",
		"INLINE=kept # dropped",
		"GLUED=value#kept",
		`DOUBLE="a b\nc"`,
		`ESCAPED="quote \" and backslash \\"`,
		`SINGLE='literal \n kept'`,
		"EMPTY=",
		"EQUAL=a=b=c",
		"1INVALID=ignored",
		"NO_SEPARATOR",
	}, "\n")

	parsed := parseEnv(text)

	want := map[string]string{
		"PLAIN":   "value",
		"SPACED":  "padded value",
		"INLINE":  "kept",
		"GLUED":   "value#kept",
		"DOUBLE":  "a b\nc",
		"ESCAPED": `quote " and backslash \`,
		"SINGLE":  `literal \n kept`,
		"EMPTY":   "",
		"EQUAL":   "a=b=c",
	}
	for key, value := range want {
		if got, ok := parsed[key]; !ok || got != value {
			t.Errorf("parseEnv()[%q] = %q (present=%v), want %q", key, got, ok, value)
		}
	}
	for _, forbidden := range []string{"1INVALID", "NO_SEPARATOR"} {
		if _, ok := parsed[forbidden]; ok {
			t.Errorf("invalid key %q must be ignored", forbidden)
		}
	}
}

func TestParseEnvHandlesCRLF(t *testing.T) {
	parsed := parseEnv("A=1\r\nB=2\r\n")
	if parsed["A"] != "1" || parsed["B"] != "2" {
		t.Fatalf("CRLF parsing: %v", parsed)
	}
}

func TestApplyEnvFileMissingIsNotFatal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent.env")
	if parsed := applyEnvFile(path); parsed != nil {
		t.Fatalf("a missing file must yield nothing, got %v", parsed)
	}
}

func TestApplyEnvFileKeepsShellValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	content := "TESTUTIL_SHELL=from-file\nTESTUTIL_EMPTY=from-file\nTESTUTIL_FRESH=from-file\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	// The shell always wins, even when the value is present but empty.
	t.Setenv("TESTUTIL_SHELL", "from-shell")
	t.Setenv("TESTUTIL_EMPTY", "")
	t.Cleanup(func() { _ = os.Unsetenv("TESTUTIL_FRESH") })

	parsed := applyEnvFile(path)
	if parsed["TESTUTIL_SHELL"] != "from-file" || parsed["TESTUTIL_FRESH"] != "from-file" {
		t.Fatalf("parsed file: %v", parsed)
	}
	if got := os.Getenv("TESTUTIL_SHELL"); got != "from-shell" {
		t.Fatalf("shell value overridden: %q", got)
	}
	if value, exists := os.LookupEnv("TESTUTIL_EMPTY"); !exists || value != "" {
		t.Fatalf("a blank shell value must not be replaced: %q (exists=%v)", value, exists)
	}
	if got := os.Getenv("TESTUTIL_FRESH"); got != "from-file" {
		t.Fatalf("missing variable not loaded: %q", got)
	}
}

// TestInitLoadsRepositoryDotEnv guards the `init()` wiring: the root `.env` is
// discovered from this source file. The file may legitimately be absent on a
// bare checkout, in which case the test is skipped.
func TestInitLoadsRepositoryDotEnv(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Skip("source path unavailable")
	}
	path := filepath.Join(repoRoot(filepath.Dir(file)), ".env")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skip("optional .env file absent")
	}
	parsed := parseEnv(string(data))
	if len(parsed) == 0 {
		t.Skip("empty .env file")
	}
	// Every key of the file was either exported by the shell already or set by
	// `init()`: in both cases it must be visible, exactly once.
	for key := range parsed {
		if _, exists := os.LookupEnv(key); !exists {
			t.Fatalf("init() did not load %q from %s", key, path)
		}
	}
}

func TestEnvFallsBackOnBlankOrMissing(t *testing.T) {
	t.Setenv("TESTUTIL_ABSENT", "")
	if got := Env("TESTUTIL_ABSENT", "fallback"); got != "fallback" {
		t.Fatalf("blank value: %q", got)
	}
	if got := Env("TESTUTIL_NEVER_SET", "fallback"); got != "fallback" {
		t.Fatalf("missing value: %q", got)
	}
	t.Setenv("TESTUTIL_SET", "  value  ")
	if got := Env("TESTUTIL_SET", "fallback"); got != "value" {
		t.Fatalf("value not trimmed: %q", got)
	}
}

func TestTestOriginFollowsEnvironment(t *testing.T) {
	t.Setenv("E2E_HOST", "")
	t.Setenv("E2E_PORT", "")
	if got := TestOrigin(); got != "http://127.0.0.1:5200" {
		t.Fatalf("default test origin: %q", got)
	}

	t.Setenv("E2E_HOST", "proxy.test")
	t.Setenv("E2E_PORT", "6000")
	if got := TestOrigin(); got != "http://proxy.test:6000" {
		t.Fatalf("configured test origin: %q", got)
	}
}

func TestAltOriginFollowsDomain(t *testing.T) {
	t.Setenv("LUMIBOOT_DOMAIN", "")
	if got := AltOrigin(); got != "https://lumiboot.example.com" {
		t.Fatalf("default domain: %q", got)
	}
	t.Setenv("LUMIBOOT_DOMAIN", "staging.example.org")
	if got := AltOrigin(); got != "https://staging.example.org" {
		t.Fatalf("custom domain: %q", got)
	}
}

func TestWebDevOriginFollowsEnvironment(t *testing.T) {
	t.Setenv("WEB_DEV_HOST", "")
	t.Setenv("WEB_DEV_PORT", "")
	if got := WebDevOrigin(); got != "http://127.0.0.1:5173" {
		t.Fatalf("default web dev origin: %q", got)
	}
	t.Setenv("WEB_DEV_HOST", "localhost")
	t.Setenv("WEB_DEV_PORT", "5300")
	if got := WebDevOrigin(); got != "http://localhost:5300" {
		t.Fatalf("configured web dev origin: %q", got)
	}
}

func TestFixedOrigins(t *testing.T) {
	if HostileOrigin() != "http://evil.example" {
		t.Fatalf("hostile origin: %q", HostileOrigin())
	}
	if OtherOrigin() != "https://other.example" {
		t.Fatalf("other origin: %q", OtherOrigin())
	}
}

func TestWispURL(t *testing.T) {
	plain := httptest.NewServer(nil)
	t.Cleanup(plain.Close)
	if got, want := WispURL(plain, "abc"), "ws"+strings.TrimPrefix(plain.URL, "http")+"/wisp/?token=abc"; got != want {
		t.Fatalf("plain: %q, want %q", got, want)
	}
	if got, want := WispURL(plain, ""), "ws"+strings.TrimPrefix(plain.URL, "http")+"/wisp/"; got != want {
		t.Fatalf("no token: %q, want %q", got, want)
	}

	secure := httptest.NewTLSServer(nil)
	t.Cleanup(secure.Close)
	if got, want := WispURL(secure, "abc"), "wss"+strings.TrimPrefix(secure.URL, "https")+"/wisp/?token=abc"; got != want {
		t.Fatalf("secure: %q, want %q", got, want)
	}
	if !strings.HasPrefix(WispURL(secure, "abc"), "wss://") {
		t.Fatal("https must upgrade to wss")
	}
}

func TestWithPort(t *testing.T) {
	origin := "http://localhost:5200"
	if got := WithPort(origin, 5201); got != "http://localhost:5201" {
		t.Fatalf("with port: %q", got)
	}
	if got := WithPort(origin+"/some/path", 5201); got != "http://localhost:5201/some/path" {
		t.Fatalf("path must be preserved: %q", got)
	}
	if got := WithPort("not an origin", 5201); got != "not an origin" {
		t.Fatalf("unparsable origin must be returned as is: %q", got)
	}
}

func TestWithScheme(t *testing.T) {
	origin := "http://127.0.0.1:5200"
	if got := WithScheme(origin, "ftp"); got != "ftp://127.0.0.1:5200" {
		t.Fatalf("with scheme: %q", got)
	}
	if got := WithScheme(origin, "https"); got != "https://127.0.0.1:5200" {
		t.Fatalf("with https: %q", got)
	}
	if got := WithScheme("not an origin", "ftp"); got != "not an origin" {
		t.Fatalf("unparsable origin must be returned as is: %q", got)
	}
}

func TestExampleFixtures(t *testing.T) {
	if ExampleHost != "example.com" || ExampleIP != "93.184.216.34" {
		t.Fatalf("example fixtures changed: %q %q", ExampleHost, ExampleIP)
	}
}
