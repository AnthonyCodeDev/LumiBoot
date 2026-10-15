//go:build linux

package platform

import "os/exec"

// OpenBrowser ouvre l'URL dans le navigateur par défaut (Linux).
func OpenBrowser(url string) error {
	return exec.Command("xdg-open", url).Start()
}
