// Binaire lumiboot-network : serveur local « Network Companion » de LumiBoot.
//
// Ce programme démarre UNIQUEMENT le serveur WebSocket WISP local (pont réseau
// vers Internet pour l'OS virtualisé). Il n'exécute AUCUNE machine virtuelle.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/lumiboot/network-companion/internal/config"
	"github.com/lumiboot/network-companion/internal/platform"
	"github.com/lumiboot/network-companion/internal/server"
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
		noBrowser  = flag.Bool("no-browser", false, "ne pas ouvrir la page d'admin au démarrage")
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

	// Bannière de démarrage.
	fmt.Println("===============================================================")
	fmt.Println(" LumiBoot Network Companion " + server.Version)
	fmt.Println("===============================================================")
	fmt.Println(" Écoute (loopback uniquement) : " + cfg.ListenAddr)
	fmt.Println(" Page d'admin locale          : " + srv.AdminURL())
	fmt.Println()
	fmt.Println(" Appairage : dans LumiBoot, choisissez le réseau « Companion »,")
	fmt.Println(" puis approuvez la demande depuis la page d'admin ci-dessus.")
	fmt.Println(" Ce programme n'exécute AUCUNE machine virtuelle.")
	fmt.Println(" Arrêt propre : Ctrl+C.")
	fmt.Println("===============================================================")

	if !*noBrowser {
		if err := platform.OpenBrowser(srv.AdminURL()); err != nil {
			fmt.Fprintln(os.Stderr, "note: ouverture du navigateur impossible: "+err.Error())
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := srv.Run(ctx); err != nil {
		return err
	}
	fmt.Println("Arrêt du compagnon : au revoir.")
	return nil
}
