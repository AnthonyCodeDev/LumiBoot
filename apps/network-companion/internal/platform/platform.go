// Package platform isole les détails par OS : emplacement du fichier de
// configuration et ouverture de la page d'admin dans le navigateur.
// Aucune élévation de privilèges n'est jamais demandée.
package platform

import (
	"os"
	"path/filepath"
)

// ConfigDirName est le dossier applicatif sous le répertoire de config de l'OS.
const ConfigDirName = "Network Companion"

// ConfigFilePath renvoie le chemin du fichier de configuration :
// <os.UserConfigDir>/LumiBoot/Network Companion/config.json.
func ConfigFilePath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "LumiBoot", ConfigDirName, "config.json"), nil
}

// EnsureConfigDir crée le dossier de configuration si besoin et le renvoie.
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
