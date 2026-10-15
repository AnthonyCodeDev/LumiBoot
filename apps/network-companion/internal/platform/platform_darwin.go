//go:build darwin

package platform

import "os/exec"

// OpenBrowser ouvre l'URL dans le navigateur par défaut (macOS).
func OpenBrowser(url string) error {
	return exec.Command("open", url).Start()
}
