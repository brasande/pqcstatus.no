// Command kvantesjekk henter offentlige nettsteder fra Enhetsregisteret og
// sjekker om de støtter post-kvante (hybrid ML-KEM) nøkkelutveksling i TLS.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "domains":
		err = runDomains(os.Args[2:])
	case "scan":
		err = runScan(os.Args[2:])
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "feil:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `bruk:
  kvantesjekk domains [-out data/domains.json]   hent nettsteder fra Enhetsregisteret
  kvantesjekk scan    [-in data/domains.json]    skann og skriv resultater til site/data`)
}

func writeJSON(path string, v any, indent bool) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	var (
		b   []byte
		err error
	)
	if indent {
		b, err = json.MarshalIndent(v, "", "  ")
	} else {
		b, err = json.Marshal(v)
	}
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}
