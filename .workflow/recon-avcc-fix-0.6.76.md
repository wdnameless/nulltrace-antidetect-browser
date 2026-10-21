# Recon — fix "Failed to parse avcC", release v0.6.76

T1 lane: user's screenshot showed `ERROR (Failed to parse avcC.)` +
Stream Error on a RUNNING profile at the now-correct 408x912.

## Root cause (measured, not guessed)

- Live CONFIG packet from the guest is Annex B:
  `00 00 00 01 67 42 c0 29 … 00 00 00 01 68 ce 01 a8 35 c8`
  (SPS type 7 + PPS type 8, 32 bytes total). Video frames are Annex B too.
- The canvas passed the raw CONFIG bytes as the WebCodecs `description`,
  which must be an ISO avcC box — Chromium rejects it with exactly
  "Failed to parse avcC". Frames were fed as Annex B instead of
  length-prefixed avcC, which WebCodecs `avc1.*` chunks require.
- Codec string is now derived from the real SPS: `avc1.42c029`.

## Touched files

- `src/renderer/src/androidStream.ts`: `splitAnnexBNals`,
  `buildAvcCDescription`, `codecStringFromConfig`, `annexBFrameToAvcC`.
- `src/renderer/src/components/AndroidCanvas.tsx`: CONFIG path builds
  avcC + codec string (dropped the byte-scanning local), frames convert
  Annex B → avcC before `EncodedVideoChunk`.
- `tests/unit/androidAvcC.test.ts` (new): 7 tests pinning the live bytes.
- Release: 4 carriers 0.6.75 → 0.6.76, CHANGELOG section.

## Acceptance check

- `tsc` main + renderer clean; `npm run build` ok; new code paths in
  the shipped bundle (minified: `avc1.` x3, `optimizeForLatency`,
  `EncodedVideoChunk`, `VideoDecoder` present).
- Full `npm test`: 196 files / 1790 passed, 12 skipped, 0 failed.
- `sbom:verify` ok; `cargo test` 58/58.
- Released: `main` + tag `v0.6.76` pushed; CI `refs/tags/v*` builds.
- Visual limit (stated): no browser host for screenshots; the user's
  update to 0.6.76 is the visual confirmation.
