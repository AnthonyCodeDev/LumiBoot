//go:build !windows && !darwin && !linux

package platform

import "errors"

// OpenBrowser n'est pas supporté sur cet OS : l'utilisateur ouvre l'URL affichée.
func OpenBrowser(_ string) error {
	return errors.New("platform: ouverture du navigateur non supportée sur cet OS")
}
