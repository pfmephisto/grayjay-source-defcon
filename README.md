# Grayjay source for media.defcon.org

A [Grayjay](https://grayjay.app) plugin for the [DEF CON media server](https://media.defcon.org):
recorded talks from every DEF CON conference that has video.

- One channel per conference (`DEF CON 9` … newest), talks listed from its video folder
- Home feed, newest conference first, paginated one conference at a time
- Search across all conferences, and within a conference
- SRT/VTT captions where the server has them
- "More from this conference" recommendations

## Install

Add this URL in Grayjay under *Sources → Add Source*:

    https://raw.githubusercontent.com/pfmephisto/grayjay-source-defcon/main/DefconConfig.json

## How it works

media.defcon.org is an nginx *fancyindex* listing with no API, so the plugin scrapes directory
pages (`DefconScript.js`, `listDir`). Each conference's talks are the video files in
`DEF CON N video and slides/` (or `DEF CON N video/` for older years); captions come from the
`… captions/` folder next to it. These are Whisper auto-transcripts in several formats that vary by year
(DEF CON 27 uses SBV content in `.srt` files); the plugin offers one track per language and converts it to
WebVTT. The same file gives the talk's real duration and a transcript excerpt for the description.

The server has no per-video images (and nothing to cut previews from without downloading the video), so every talk
is shown with its conference's logo from media.defcon.org. The plugin uses nothing else for images: no third-party
service and nothing stored in this repo.

**Known limitation:** Grayjay Desktop cannot display them. It downloads thumbnails itself with an HTTP/1.1 client and
gives plugins no say in it (video segments, by contrast, go through the plugin's `RequestExecutor`), and
media.defcon.org resets every HTTP/1.1 connection (all `defcon.org` hosts do, even on plain port 80 or by IP), so on
Desktop the logos stay blank. On Desktop the all-conferences channel list skips them entirely rather than spend a
directory listing per conference on images that cannot load. They work on clients whose image loader speaks HTTP/2,
and would work on Desktop if either media.defcon.org accepted HTTP/1.1 or Grayjay Desktop's image downloader used an
HTTP/2-capable client.

The podcast feeds in `DEF CON rss/` are deliberately not used: their enclosure URLs predate a file
rename and now 404.

### Playback

The server sends `Cross-Origin-Resource-Policy: same-origin` and its files are progressive MP4 (no segment index),
so Grayjay Desktop's browser player cannot load them from the server directly: it fails with a generic "an error
occurred while playing the video". On Desktop the plugin therefore does what the YouTube plugin does: it hands the
app a DASH stream whose segments come from a plugin `RequestExecutor`. For each talk it reads the file's index
(`moov`, roughly 1 MB), then answers init and segment requests by fetching byte ranges of the original file and
wrapping the samples in fragmented-MP4 `moof`+`mdat` boxes (about 6 s each, cut at keyframes). Nothing is
transcoded or stored, and no relay is involved. Other clients (Android) get the plain file URL, which they can load
directly. If a file is not a progressive MP4 with one video and one audio track, Desktop falls back to the plain URL.

Subtitles and thumbnails have the same problem (Desktop downloads them with an HTTP/1.1 client and the server resets
every HTTP/1.1 connection), so subtitles are fetched by the plugin (thumbnails are covered above).

The server's FAQ asks people to go easy on bandwidth, so listings are fetched once per session and cached, downloads
are limited to one at a time, and nothing outside the video folders is touched. Seeking costs one range request per
segment.

Videos are AV1 with Opus audio (the server FAQ says HEVC, but every file sampled from DEF CON 9 to 34 is AV1).
## Development

```sh
node test/harness.js 32 27 12       # live smoke test against the real site (needs node + curl)
python -m http.server               # serve the repo, then add http://localhost:8000/DefconConfig.dev.json in Grayjay
```

Grayjay's [plugin development guide](https://gitlab.futo.org/videostreaming/grayjay/-/blob/master/plugin-development.md)
covers the DevServer and the plugin API; `plugin.d.ts` has the typings.

### Releasing

1. Edit `DefconScript.js`, bump `version` (and the `changelog`) in `DefconConfig.json`.
2. `./sign.sh` (needs `openssl` and `jq`) signs the script and writes `scriptSignature` and
   `scriptPublicKey` into the config. The private key is **not** in this repo; it defaults to
   `~/.config/grayjay-source-defcon/private_key.pem` (override with `PRIVKEY=`). Keep using the same
   key, or installed copies will refuse the update.
3. Commit and push.

## Licence

AGPL-3.0, see `LICENSE`. DEF CON and its logo are trademarks of DEF CON Communications, Inc.; the icon
is used only to identify the source. This project is not affiliated with DEF CON or FUTO.
