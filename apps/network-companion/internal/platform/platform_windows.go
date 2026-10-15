//go:build windows

package platform

import "os/exec"

// OpenBrowser ouvre l'URL dans le navigateur par défaut (Windows).
func OpenBrowser(url string) error {
	return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}
