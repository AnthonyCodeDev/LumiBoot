// Command lumiboot-network is the local network proxy: a WISP WebSocket server
// plus an interactive console for pairing and sessions. It runs no VM.
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
		configPath = flag.String("config", "", "path to the JSON config file (default: OS config folder)")
		listen     = flag.String("listen", "", "override the listen address (must stay loopback)")
		showVer    = flag.Bool("version", false, "print the version and exit")
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
			return fmt.Errorf("config path not found: %w", err)
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

	// Server and console run in parallel; when one stops the other is cancelled.
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
	fmt.Println("Local network proxy stopped. Goodbye.")
	return nil
}

func printBanner(listenAddr string) {
	rule := strings.Repeat("─", 60)
	fmt.Println(rule)
	fmt.Printf(" LumiBoot Network Proxy — v%s\n", server.Version)
	fmt.Println(rule)
	fmt.Printf(" Local WISP endpoint : ws://%s/wisp/\n", listenAddr)
	fmt.Printf(" Listening           : %s (loopback only)\n", listenAddr)
	fmt.Println(" Security            : private networks / loopback / metadata blocked")
	fmt.Println(" Authorization       : automatic on the LumiBoot side; approve below")
	fmt.Println(rule)
	fmt.Println(` Type "help" for commands — Ctrl+C to stop.`)
}
