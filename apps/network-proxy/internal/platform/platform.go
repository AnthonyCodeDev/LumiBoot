// Package platform isolates OS-specific details: the location of the
// configuration file. No privilege escalation is ever requested.
package platform

import (
	"os"
	"path/filepath"
)

const ConfigDirName = "Network Proxy"

// ConfigFilePath returns <os.UserConfigDir>/LumiBoot/Network Proxy/config.json.
func ConfigFilePath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "LumiBoot", ConfigDirName, "config.json"), nil
}

func EnsureConfigDir() (string, error) {
	path, err := ConfigFilePath()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}
