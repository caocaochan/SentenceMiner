# SentenceMiner

SentenceMiner is an `mpv`-first sentence mining workflow:

- a local helper server hosts a live subtitle page you can scan with Yomitan
- an `mpv` Lua script watches the current subtitle in real time
- when you trigger the mining action, it captures the subtitle text, matching audio, and a screenshot
- the helper updates the newest matching Anki note through AnkiConnect

The UI uses a Catppuccin Macchiato-inspired theme and keeps a running subtitle history for the current playback session.

## What v1 does

- shows the current subtitle and transcript history on `localhost`
- keeps the text selectable and Yomitan-friendly
- updates the newest matching Anki note by highest note ID
- replaces configured subtitle, audio, and image fields
- supports configurable deck, note type, field names, image sizing, image format, and audio padding

## Project Layout

- [src/server.ts](C:/Users/CaoCao/Downloads/SentenceMiner/src/server.ts) helper server, API routes, and WebSocket fanout
- [src/anki.ts](C:/Users/CaoCao/Downloads/SentenceMiner/src/anki.ts) AnkiConnect note lookup and updates
- [web/index.html](C:/Users/CaoCao/Downloads/SentenceMiner/web/index.html) local Yomitan-facing subtitle site
- [mpv/sentenceminer.lua](C:/Users/CaoCao/Downloads/SentenceMiner/mpv/sentenceminer.lua) `mpv` integration and capture workflow

## Requirements

- Node.js 24 or newer
- `mpv`
- `ffmpeg`
- Anki with AnkiConnect enabled

## Setup

1. Copy [sentenceminer.config.example.json](C:/Users/CaoCao/Downloads/SentenceMiner/sentenceminer.config.example.json) to `sentenceminer.config.json`.
2. Edit the Anki deck, note type, and field mappings in `sentenceminer.config.json`.
3. Copy [mpv/sentenceminer.lua](C:/Users/CaoCao/Downloads/SentenceMiner/mpv/sentenceminer.lua) into your `mpv/scripts` directory.
4. Copy [script-opts/sentenceminer.conf.example](C:/Users/CaoCao/Downloads/SentenceMiner/script-opts/sentenceminer.conf.example) to `mpv/script-opts/sentenceminer.conf`.
5. Make sure `helper_url` in the mpv config matches the helper server, which defaults to `http://127.0.0.1:8766`.
6. Start the helper:

```powershell
node --experimental-strip-types src/server.ts
```

7. Bind a mining hotkey in `mpv/input.conf`:

```conf
Ctrl+m script-message-to sentenceminer mine
```

8. Open `http://127.0.0.1:8766` in your browser and use Yomitan on the live transcript.

## Configuration

### Helper config

`sentenceminer.config.json` includes:

- `server.host`, `server.port`
- `anki.url`, `anki.apiKey`
- `anki.deck`, `anki.noteType`, `anki.extraQuery`
- `anki.fields.subtitle`, `anki.fields.audio`, `anki.fields.image`
- optional `anki.fields.source`, `anki.fields.time`, `anki.fields.filename`
- `anki.filenameTemplate`
- `capture.audioPrePaddingMs`, `capture.audioPostPaddingMs`
- `capture.audioFormat`, `capture.audioCodec`, `capture.audioBitrate`
- `capture.imageFormat`, `capture.imageQuality`, `capture.imageMaxWidth`, `capture.imageMaxHeight`
- `capture.imageIncludeSubtitles`
- `transcript.historyLimit`

### mpv script options

`script-opts/sentenceminer.conf` includes:

- `helper_url`
- `helper_timeout_ms`
- `ffmpeg_path`
- `temp_dir`
- `capture_audio`
- `capture_image`
- optional `bind_default_key`

## Scripts

```powershell
node --experimental-strip-types src/server.ts
node --experimental-strip-types --test test/*.test.ts
```

## Notes

- The helper defaults to port `8766` so it does not collide with AnkiConnect on `8765`.
- v1 keeps transcript history in memory only.
- v1 only tracks the primary active subtitle.
- The target note is the newest matching note returned by the configured deck, note type, and extra query.
