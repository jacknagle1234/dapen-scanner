# Go crawler source (vendored)

Copy the entire `crawler/` directory from the main DAPEN repo into this folder: all `.go` files, `go.mod`, and `go.sum`. Then from this project root run:

- `./scripts/build-crawler-linux.sh` — builds `bin/crawler` for linux/amd64 (or set `CRAWLER_ARCH=arm64` for ARM)
- or `npm run build:crawler`

The resulting binary is used by the Node runner and must be built for Linux when deploying to Railway.
