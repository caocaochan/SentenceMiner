# SentenceMiner

SentenceMiner is an `mpv`-first sentence mining workflow:

- a local helper server hosts a live subtitle page you can scan with Yomitan
- an `mpv` Lua script watches the current subtitle in real time
- when you trigger the mining action, it captures the subtitle text, matching audio, and a screenshot
- captured audio is loudness-normalized so mined cards play back at a more consistent volume
- the helper updates matching Anki notes only when the stored sentence matches what you mined

The UI uses a Catppuccin Macchiato-inspired theme and keeps a running subtitle history for the current playback session.

## Downloads

- Latest packaged zip: `https://github.com/caocaochan/SentenceMiner/releases/latest/download/SentenceMiner-latest.zip`
- Source snapshot of `main`: `https://github.com/caocaochan/SentenceMiner/archive/refs/heads/main.zip`

The packaged zip is the recommended Windows download. It includes a self-contained `SentenceMinerHelper.exe` and a bundled `ffmpeg.exe`, so end users do not need to install Node.js or provide `ffmpeg` separately.

## What v1 does

- shows the current subtitle and transcript history on `localhost`
- keeps the text selectable and Yomitan-friendly
- auto-starts the helper on Windows when `mpv` loads a file
- updates an existing Anki note only when its sentence matches the mined subtitle text
- returns an error when no existing sentence matches
- replaces configured subtitle, audio, and image fields
- supports configurable deck, note type, field names, image sizing, image format, and audio padding

## Project Layout

- [src/server.ts](C:/Users/CaoCao/Downloads/SentenceMiner/src/server.ts) helper server, API routes, and WebSocket fanout
- [src/main.ts](C:/Users/CaoCao/Downloads/SentenceMiner/src/main.ts) executable entrypoint for development and packaged helpers
- [src/anki.ts](C:/Users/CaoCao/Downloads/SentenceMiner/src/anki.ts) AnkiConnect note lookup and updates
- [web/index.html](C:/Users/CaoCao/Downloads/SentenceMiner/web/index.html) local Yomitan-facing subtitle site
- [mpv/sentenceminer.lua](C:/Users/CaoCao/Downloads/SentenceMiner/mpv/sentenceminer.lua) `mpv` integration and capture workflow
- [scripts/build-helper.mjs](C:/Users/CaoCao/Downloads/SentenceMiner/scripts/build-helper.mjs) Windows helper executable build

## End-User Requirements

- Windows
- `mpv`
- Anki with AnkiConnect enabled

Node.js and `ffmpeg` are not required for the packaged Windows release.

## Windows Setup

1. Download and extract `SentenceMiner-latest.zip`.
2. Extract it directly into your `mpv` folder so the zip's `scripts/` and `script-opts/` folders merge into `mpv/scripts/` and `mpv/script-opts/`.
3. Edit `mpv/script-opts/sentenceminer.conf` with your Anki deck, note type, field mappings, and any script options you want to customize.
4. Play a video in `mpv`.
5. Press `Ctrl+Shift+m` once to enable SentenceMiner for the current `mpv` session. That will start the helper flow and open the local transcript site, and then you can use `Ctrl+m` to mine the current subtitle.

The helper starts automatically on first playback. You should not need to run `SentenceMinerHelper.exe` yourself unless you are debugging. The packaged release already includes `script-opts/sentenceminer.conf` with a relative helper path and a default `Ctrl+m` mining hotkey.

## Configuration

### Shared config

`script-opts/sentenceminer.conf` is the only config file. It includes the mpv script options plus the helper settings below:

- `server_host`, `server_port`
- `anki_url`, `anki_api_key`
- `anki_deck`, `anki_note_type`, `anki_extra_query`
- `anki_field_subtitle`, `anki_field_audio`, `anki_field_image`
- optional `anki_field_source`, `anki_field_time`, `anki_field_filename`
- `anki_filename_template`
- `capture_audio_pre_padding_ms`, `capture_audio_post_padding_ms`
- `capture_audio_format`, `capture_audio_codec`, `capture_audio_bitrate`
- `capture_image_format`, `capture_image_quality`, `capture_image_max_width`, `capture_image_max_height`
- `capture_image_include_subtitles`
- `transcript_history_limit`

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
- optional `bind_toggle_key`, `toggle_key`

If you change the helper listen host or port, keep `helper_url` aligned with `server_host` and `server_port`.

SentenceMiner now starts disabled every time `mpv` launches. Use `Ctrl+Shift+m` to enable it for the current session; that toggle is not saved back to `sentenceminer.conf`.

In the packaged release, `helper_exe_path` is preconfigured to `sentenceminer-helper/SentenceMinerHelper.exe`, `ffmpeg_path` points at the bundled `ffmpeg.exe`, and `bind_default_key=yes`, so extraction into the `mpv` folder is enough to start using the script. Source builds can still leave `helper_exe_path` empty and `ffmpeg_path=ffmpeg` to rely on auto-discovery and `PATH`.

## Developer Workflow

For source development you still need Node.js 24 or newer. You also need `ffmpeg` on `PATH` or a custom `ffmpeg_path` in `script-opts/sentenceminer.conf`.

```powershell
npm install
node --experimental-strip-types src/main.ts
node --experimental-strip-types --test test/*.test.ts
node scripts/build-helper.mjs
node scripts/package-release.mjs
```

`build-helper.mjs` currently targets Windows builds and produces `dist/build/helper/SentenceMinerHelper.exe`.

## Notes

- The helper defaults to port `8766` so it does not collide with AnkiConnect on `8765`.
- If another process is already using the helper port, `mpv` will show a startup error instead of silently failing.
- The packaged helper resolves `web/` assets relative to `SentenceMinerHelper.exe` and loads config from `mpv/script-opts/sentenceminer.conf`.
- The packaged release bundles `ffmpeg.exe`, `ffmpeg.exe.LICENSE`, and `ffmpeg.exe.README` inside `mpv/scripts/sentenceminer-helper/`.
- v1 keeps transcript history in memory only.
- v1 only tracks the primary active subtitle.
- SentenceMiner first looks for matching notes returned by the configured deck, note type, and extra query.
- Mining is blocked unless the configured deck, note type, and mapped fields currently exist in Anki.
- SentenceMiner only inspects the newest note returned by the configured deck, note type, and extra query.
- That newest note is only updated when its configured subtitle field matches the mined sentence after HTML and whitespace normalization.
- If no note matches, SentenceMiner returns `No matching card exists.` instead of overwriting an unrelated note.
- The GitHub Actions workflow at `.github/workflows/release-latest.yml` rebuilds `SentenceMiner-latest.zip` on every push to `main`.
