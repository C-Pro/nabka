package nabka

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
	"unicode"
)

func TestStaticFS(t *testing.T) {
	fsys := FS()

	requiredFiles := []string{
		"index.html",
		"css/main.css",
		"css/tailwind.css",
		"data/world_map.json",
		"data/npc_dialogues.json",
		"data/police_dialogues.json",
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
		"js/models.js",
		"js/quests.js",
		"js/noon-cannon.js",
		"js/camera-effects.js",
		"models/fountain.glb",
		"models/dynamo_stadium.glb",
		"models/ocean_cinema.glb",
		"models/car_0.glb",
		"models/player.glb",
		"models/dunya.glb",
		"models/berik.glb",
		"models/police_officer.glb",
		"models/police_car.glb",
		"audio/ch1.mp3",
		"audio/ch2.mp3",
		"audio/ch3.mp3",
		"audio/ch_long1.mp3",
		"audio/ch_long2.mp3",
		"audio/nabka_ambience.mp3",
		"audio/roadster_start.mp3",
		"audio/roadster_idle.mp3",
		"audio/roadster_driving.mp3",
		"audio/drift1.mp3",
		"audio/drift2.mp3",
		"audio/drift3.mp3",
		"audio/drift4.mp3",
		"audio/cannon.mp3",
		"audio/dive.mp3",
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

	// Ensure standalone editor files are NOT embedded in the server binary
	for _, forbidden := range []string{"editor/index.html", "editor/editor.js", "editor/export_glb.js"} {
		if f, err := fsys.Open(forbidden); err == nil {
			_ = f.Close()
			t.Fatalf("expected standalone editor file %s NOT to be embedded in static FS", forbidden)
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
	for _, jsonPath := range []string{"data/world_map.json", "data/npc_dialogues.json", "data/police_dialogues.json"} {
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

func containsCyrillic(s string) bool {
	for _, r := range s {
		if unicode.In(r, unicode.Cyrillic) {
			return true
		}
	}
	return false
}

func TestPoliceDialoguesEmbeddedSchema(t *testing.T) {
	type policeOption struct {
		Index int    `json:"index"`
		Text  string `json:"text"`
		Reply string `json:"reply"`
		Fine  int64  `json:"fine"`
	}
	type policeScenario struct {
		ID      string         `json:"id"`
		Title   string         `json:"title"`
		Opening string         `json:"opening"`
		Options []policeOption `json:"options"`
	}
	type policeDialoguesFile struct {
		Scenarios []policeScenario `json:"scenarios"`
	}

	fsys := FS()
	f, err := fsys.Open("data/police_dialogues.json")
	if err != nil {
		t.Fatalf("open data/police_dialogues.json: %v", err)
	}
	defer f.Close()

	raw, err := io.ReadAll(f)
	if err != nil {
		t.Fatalf("read data/police_dialogues.json: %v", err)
	}

	var parsed policeDialoguesFile
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("unmarshal data/police_dialogues.json: %v", err)
	}

	if len(parsed.Scenarios) < 4 {
		t.Fatalf("expected at least 4 police dialogue scenarios, got %d", len(parsed.Scenarios))
	}

	seenIDs := make(map[string]bool)
	for _, sc := range parsed.Scenarios {
		id := strings.TrimSpace(sc.ID)
		if id == "" {
			t.Fatal("scenario has empty id")
		}
		if seenIDs[id] {
			t.Fatalf("duplicate scenario id %q", id)
		}
		seenIDs[id] = true

		if strings.TrimSpace(sc.Title) == "" || !containsCyrillic(sc.Title) {
			t.Fatalf("scenario %q must have Russian title, got %q", id, sc.Title)
		}
		if strings.TrimSpace(sc.Opening) == "" || !containsCyrillic(sc.Opening) {
			t.Fatalf("scenario %q must have Russian opening, got %q", id, sc.Opening)
		}
		if len(sc.Options) < 2 {
			t.Fatalf("scenario %q must have at least 2 options, got %d", id, len(sc.Options))
		}
		for i, opt := range sc.Options {
			if opt.Index != i {
				t.Fatalf("scenario %q option %d has non-contiguous index %d", id, i, opt.Index)
			}
			if strings.TrimSpace(opt.Text) == "" || !containsCyrillic(opt.Text) {
				t.Fatalf("scenario %q option %d must have Russian text, got %q", id, i, opt.Text)
			}
			if strings.TrimSpace(opt.Reply) == "" || !containsCyrillic(opt.Reply) {
				t.Fatalf("scenario %q option %d must have Russian reply, got %q", id, i, opt.Reply)
			}
			if opt.Fine < 0 {
				t.Fatalf("scenario %q option %d has negative fine %d", id, i, opt.Fine)
			}
			if id == "weed_shakedown" && opt.Fine <= 0 {
				t.Fatalf("weed_shakedown option %d must deduct money (fine > 0), got %d", i, opt.Fine)
			}
		}
	}

	for _, reqID := range []string{"person_search", "weed_shakedown", "document_check", "public_order"} {
		if !seenIDs[reqID] {
			t.Fatalf("required scenario %q missing from data/police_dialogues.json", reqID)
		}
	}
}
