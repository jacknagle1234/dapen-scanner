#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

if [[ ! -d crawler ]]; then
  echo "Error: crawler/ directory not found. Copy the Go crawler source from the main DAPEN repo into this project's crawler/ directory first." >&2
  exit 1
fi

if ! command -v go &>/dev/null; then
  echo "Error: go is not installed or not in PATH." >&2
  exit 1
fi

ARCH="${CRAWLER_ARCH:-amd64}"
mkdir -p bin
GOOS=linux GOARCH="$ARCH" go build -o bin/crawler ./crawler
chmod +x bin/crawler
echo "Built bin/crawler for linux/$ARCH"
