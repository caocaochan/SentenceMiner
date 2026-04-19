# SentenceMiner

SentenceMiner is an `mpv`-first sentence mining workflow:

- a local helper server hosts a live subtitle page you can scan with Yomitan
- an `mpv` Lua script watches the current subtitle in real time
- when you trigger the mining action, it captures the subtitle text, matching audio, and a screenshot
- the helper updates the newest matching Anki note through AnkiConnect

The UI uses a Catppuccin Macchiato-inspired theme and keeps a running subtitle history for the current playback session.

## Downloads

- Latest packaged zip: `https://github.com/caocaochan/SentenceMiner/releases/latest/download/SentenceMiner-latest.zip`
- Source snapshot of `main`: `https://github.com/caocaochan/SentenceMiner/archive/refs/heads/main.zip`

The packaged zip is the recommended Windows download. It includes a self-contained `SentenceMinerHelper.exe`, so end users do not need to install Node.js or start a separate `.bat` file.

## What v1 does

- shows the current subtitle and transcript history on `localhost`
- keeps the text selectable and Yomitan-friendly
- auto-starts the helper on Windows when `mpv` loads a file
- updates the newest matching Anki note by highest note ID
- replaces configured subtitle, audio, and image fields
- supports configurable deck, note type, field names, image sizing, image format, and audio padding

## Project Layout

- [src/server.ts](C:/Users/CaoCao/Downloads/SentenceMiner/src/server.ts) helper server, API routes, and WebSocket fanout
- [src/anki.ts](C:/Users/CaoCao/Downloads/SentenceMiner/src/anki.ts) AnkiConnect note lookup and updates
- [web/index.html](C:/Users/CaoCao/Downloads/SentenceMiner/web/index.html) local Yomitan-facing subtitle site
- [mpv/sentenceminer.lua](C:/Users/CaoCao/Downloads/SentenceMiner/mpv/sentenceminer.lua) `mpv` integration and capture workflow
- [scripts/build-helper.mjs](C:/Users/CaoCao/Downloads/SentenceMiner/scripts/build-helper.mjs) Windows helper executable build

## End-User Requirements

- Windows
- `mpv`
- `ffmpeg`
- Anki with AnkiConnect enabled

Node.js is not required for the packaged Windows release.

## Windows Setup

1. Download and extract `SentenceMiner-latest.zip`.
2. Copy everything from `SentenceMiner/mpv/scripts/` into your `mpv/scripts/` directory.
3. Copy `SentenceMiner/mpv/script-opts/sentenceminer.conf.example` to `mpv/script-opts/sentenceminer.conf`.
4. Copy `mpv/scripts/sentenceminer-helper/sentenceminer.config.example.json` to `mpv/scripts/sentenceminer-helper/sentenceminer.config.json`.
5. Edit `sentenceminer.config.json` with your Anki deck, note type, and field mappings.
6. Bind a mining hotkey in `mpv/input.conf`:

```conf
Ctrl+m script-message-to sentenceminer mine
```

7. Play a video in `mpv`.
8. Open `http://127.0.0.1:8766` in your browser and use Yomitan on the live transcript.

The helper starts automatically on first playback. You should not need to run `SentenceMinerHelper.exe` yourself unless you are debugging.

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
- `helper_auto_start`
- `helper_exe_path`
- `helper_start_timeout_ms`
- `ffmpeg_path`
- `temp_dir`
- `capture_audio`
- `capture_image`
- optional `bind_default_key`

By default, `helper_exe_path` can stay empty. The script looks for `SentenceMinerHelper.exe` in a `sentenceminer-helper` folder next to `sentenceminer.lua`.

## Developer Workflow

For source development you still need Node.js 24 or newer.

```powershell
npm install
node --experimental-strip-types src/server.ts
node --experimental-strip-types --test test/*.test.ts
node scripts/build-helper.mjs
node scripts/package-release.mjs
```

`build-helper.mjs` currently targets Windows builds and produces `dist/build/helper/SentenceMinerHelper.exe`.

## Notes

- The helper defaults to port `8766` so it does not collide with AnkiConnect on `8765`.
- If another process is already using the helper port, `mpv` will show a startup error instead of silently failing.
- The packaged helper resolves `web/` assets and `sentenceminer.config.json` relative to `SentenceMinerHelper.exe`, so it can be launched from `mpv` without depending on the current working directory.
- v1 keeps transcript history in memory only.
- v1 only tracks the primary active subtitle.
- The target note is the newest matching note returned by the configured deck, note type, and extra query.
- The GitHub Actions workflow at `.github/workflows/release-latest.yml` rebuilds `SentenceMiner-latest.zip` on every push to `main`.
