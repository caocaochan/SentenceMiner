# SentenceMiner

Extract this zip directly into your `mpv` folder so the included `scripts/` and `script-opts/` folders merge into the existing `mpv/scripts/` and `mpv/script-opts/` directories.

This packaged Windows build already includes:

- `SentenceMinerHelper.exe`
- `ffmpeg.exe`

You do not need to install Node.js or provide a separate `ffmpeg` binary.

Default shortcuts:
- `Ctrl+m` mines the current subtitle.
- `Ctrl+Shift+m` toggles SentenceMiner on or off and persists that state in `script-opts/sentenceminer.conf`.
