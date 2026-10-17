package nabka

import (
	"embed"
	"io/fs"
)

//go:embed all:static
var embeddedFS embed.FS

// FS returns an fs.FS representing the contents of the static directory,
// with the "static/" path prefix stripped so that "index.html" is at the root.
func FS() fs.FS {
	sub, err := fs.Sub(embeddedFS, "static")
	if err != nil {
		panic(err)
	}
	return sub
}
