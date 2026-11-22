# Audio compatibility fixture

`tone.ogg` is a generated two-second 440 Hz tone (Vorbis in Ogg), not user audio.
It loads in Chromium but is not decodable by the tested macOS WebKit 27.2 build.
The supported upload must use container duration when browser metadata fails.

Generated with FFmpeg:

```sh
ffmpeg -f lavfi -i sine=frequency=440:duration=2 -c:a libvorbis tone.ogg
```

`headerless.webm` is a generated 15-second Opus tone in live WebM (no duration
header). On native Safari 18.3.1 it loads normally, but the old metadata probe's
`currentTime = 1e10` produces a media network/range failure. It also exercises
container-derived playback timing for Chromium's indefinite-duration sources.

```sh
ffmpeg -f lavfi -i sine=frequency=440:duration=15 -c:a libopus -b:a 96k -f webm -live 1 headerless.webm
```
