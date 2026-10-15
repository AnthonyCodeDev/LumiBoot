// Binaire lumiboot-network : « LumiBoot Network Proxy » local.
//
// Ce programme démarre le serveur WebSocket WISP local (pont réseau vers
// Internet pour l'OS virtualisé) et une console interactive d'administration
// (appairage, sessions). Il n'exécute AUCUNE machine virtuelle.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/lumiboot/network-proxy/internal/config"
	"github.com/lumiboot/network-proxy/internal/console"
	"github.com/lumiboot/network-proxy/internal/platform"
	"github.com/lumiboot/network-proxy/internal/server"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "lumiboot-network: "+err.Error())
		os.Exit(1)
	}
}

func run() error {
	var (
		configPath = flag.String("config", "", "chemin du fichier config JSON (défaut : dossier config de l'OS)")
		listen     = flag.String("listen", "", "surcharge de l'adresse d'écoute (doit rester loopback)")
		showVer    = flag.Bool("version", false, "affiche la version et quitte")
	)
	flag.Parse()

	if *showVer {
		fmt.Println("lumiboot-network " + server.Version)
		return nil
	}

	path := *configPath
	if path == "" {
		p, err := platform.ConfigFilePath()
		if err != nil {
			return fmt.Errorf("chemin de config introuvable: %w", err)
		}
		path = p
	}
	cfg, err := config.Load(path)
	if err != nil {
		return err
	}
	if *listen != "" {
		cfg.ListenAddr = *listen
		if err := cfg.Validate(); err != nil {
			return err
		}
	}

	srv, err := server.New(cfg)
	if err != nil {
		return err
	}

	printBanner(cfg.ListenAddr)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Serveur HTTP/WS et console interactive en parallèle : dès que l'un
	// s'arrête, on annule le contexte et on laisse l'autre se terminer.
	errCh := make(chan error, 2)
	go func() { errCh <- srv.Run(ctx) }()
	go func() { errCh <- console.New(srv.Authenticator(), os.Stdin, os.Stdout).Run(ctx) }()

	pending := 2
	var firstErr error
	select {
	case <-ctx.Done():
	case err := <-errCh:
		pending--
		if err != nil {
			firstErr = err
		}
	}
	cancel()
	for pending > 0 {
		if err := <-errCh; err != nil && firstErr == nil {
			firstErr = err
		}
		pending--
	}

	if firstErr != nil {
		return firstErr
	}
	fmt.Println("Arrêt du proxy réseau local : au revoir.")
	return nil
}

// printBanner affiche la bannière de démarrage (sobre, alignée).
func printBanner(listenAddr string) {
	rule := strings.Repeat("─", 60)
	fmt.Println(rule)
	fmt.Printf(" LumiBoot Network Proxy — v%s\n", server.Version)
	fmt.Println(rule)
	fmt.Printf(" Endpoint WISP local : ws://%s/wisp/\n", listenAddr)
	fmt.Printf(" Écoute              : %s (loopback uniquement)\n", listenAddr)
	fmt.Println(" Sécurité            : réseaux privés / loopback / métadonnées bloqués")
	fmt.Println(" Autorisation        : automatique côté LumiBoot ; à approuver ci-dessous")
	fmt.Println(rule)
	fmt.Println(" Tapez « help » pour les commandes — Ctrl+C pour arrêter.")
}
