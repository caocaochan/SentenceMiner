# Third-Party Assets

## Yomitan

`third_party/yomitan` contains the unpacked Chrome/Edge build of Yomitan Popup Dictionary version `26.4.6.0`.

- Project: https://github.com/yomidevs/yomitan
- Website: https://yomitan.wiki/
- License: GPL-3.0, copied in `third_party/yomitan/LICENSE`

SentenceMiner distributes Yomitan as a separate browser extension asset for the Electron overlay. The vendored copy includes small Electron compatibility patches so unsupported extension APIs cannot prevent the extension backend from becoming ready, and the default first-run guide flag is disabled. Dictionaries are not bundled and remain user-installed.
