// install-protoc downloads and verifies the pinned official Linux x86_64 protoc archive.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const (
	protocVersion = "29.5"
	protocSHA256  = "a3f094363cd205c6f7af0d1b9305cb4c8517043f265cdb188f098cae93e8b217"
	protocURL     = "https://github.com/protocolbuffers/protobuf/releases/download/v29.5/protoc-29.5-linux-x86_64.zip"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: install-protoc <destination>")
		os.Exit(2)
	}
	if err := install(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func install(destination string) error {
	client := &http.Client{Timeout: 2 * time.Minute}
	response, err := client.Get(protocURL)
	if err != nil {
		return fmt.Errorf("download protoc %s: %w", protocVersion, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("download protoc %s: HTTP %s", protocVersion, response.Status)
	}
	archive, err := io.ReadAll(io.LimitReader(response.Body, 16*1024*1024))
	if err != nil {
		return fmt.Errorf("read protoc archive: %w", err)
	}
	sum := sha256.Sum256(archive)
	if actual := hex.EncodeToString(sum[:]); actual != protocSHA256 {
		return fmt.Errorf("protoc archive checksum mismatch: got %s", actual)
	}
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		return fmt.Errorf("open protoc archive: %w", err)
	}
	var binary *zip.File
	for _, file := range reader.File {
		if file.Name == "bin/protoc" {
			binary = file
			break
		}
	}
	if binary == nil {
		return fmt.Errorf("protoc %s archive has no bin/protoc", protocVersion)
	}
	source, err := binary.Open()
	if err != nil {
		return fmt.Errorf("open protoc binary: %w", err)
	}
	defer source.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return fmt.Errorf("create protoc destination: %w", err)
	}
	temporary := destination + ".tmp"
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return fmt.Errorf("create protoc binary: %w", err)
	}
	if _, err := io.Copy(output, source); err != nil {
		output.Close()
		os.Remove(temporary)
		return fmt.Errorf("extract protoc binary: %w", err)
	}
	if err := output.Sync(); err != nil {
		output.Close()
		os.Remove(temporary)
		return fmt.Errorf("sync protoc binary: %w", err)
	}
	if err := output.Close(); err != nil {
		os.Remove(temporary)
		return fmt.Errorf("close protoc binary: %w", err)
	}
	if err := os.Chmod(temporary, 0o755); err != nil {
		os.Remove(temporary)
		return fmt.Errorf("set protoc executable permissions: %w", err)
	}
	if err := os.Rename(temporary, destination); err != nil {
		os.Remove(temporary)
		return fmt.Errorf("install protoc binary: %w", err)
	}
	return nil
}
