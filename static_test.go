package nabka

import (
	"encoding/json"
	"io"
	"testing"
)

func TestStaticFS(t *testing.T) {
	fsys := FS()

	requiredFiles := []string{
		"index.html",
		"css/main.css",
		"css/tailwind.css",
		"data/world_map.json",
		"data/npc_dialogues.json",
		"js/main.js",
		"js/msgpack.js",
		"js/physics.js",
		"js/state.js",
		"js/audio.js",
		"js/textures.js",
		"js/ui.js",
		"js/world.js",
		"js/entities.js",
		"js/network.js",
		"js/input.js",
	}

	for _, path := range requiredFiles {
		f, err := fsys.Open(path)
		if err != nil {
			t.Fatalf("expected %s to be present in embedded FS: %v", path, err)
		}
		stat, err := f.Stat()
		_ = f.Close()
		if err != nil {
			t.Fatalf("failed to stat %s: %v", path, err)
		}
		if stat.Size() == 0 {
			t.Fatalf("%s is unexpectedly empty", path)
		}
	}

	f, err := fsys.Open("index.html")
	if err != nil {
		t.Fatalf("expected index.html to be present in embedded FS: %v", err)
	}
	defer f.Close()

	head := make([]byte, 15)
	if _, err := io.ReadFull(f, head); err != nil {
		t.Fatalf("failed to read from index.html: %v", err)
	}
	if string(head) != "<!DOCTYPE html>" {
		t.Fatalf("unexpected head content: %s", string(head))
	}

	// Verify JSON data files are valid JSON consumable by the Go server
	for _, jsonPath := range []string{"data/world_map.json", "data/npc_dialogues.json"} {
		jf, err := fsys.Open(jsonPath)
		if err != nil {
			t.Fatalf("failed to open %s: %v", jsonPath, err)
		}
		raw, err := io.ReadAll(jf)
		_ = jf.Close()
		if err != nil {
			t.Fatalf("failed to read %s: %v", jsonPath, err)
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatalf("invalid JSON in %s: %v", jsonPath, err)
		}
	}
}
