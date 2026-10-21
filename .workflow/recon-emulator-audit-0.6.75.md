# Recon — emulator audit: late-join stream, ports, release v0.6.75

T1 lane: user asked to analyse all emulator problems, fix everything,
and release.

## Problems found (by reading code, then proven live)

1. Late-joining stream client parsed the first frame header as the
   12-byte codec-meta prefix → every packet shifted → decoder never
   configures → black canvas on a healthy stream. This is the black
   screen from the user's screenshot (main page joins after the host
   already consumed the prefix).
2. Late joiners never received the CONFIG packet (SPS/PPS): sent once
   per stream, never replayed → decoder unconfigurable even with the
   meta fix alone.
3. Tickets carried the requested 412x915 while the encoder serves
   408x912 → layout box mismatched the picture.
4. Concurrent `allocateEmulatorPorts()` calls could hand out the same
   console/ADB pair (probe-then-spawn race) → second emulator dies on
   occupied ports. Matters now that multi-window invites parallel
   starts.
5. `AndroidWindow` poller closed over the first render's `ticket` →
   stale acquire/drop decisions.

## Touched files

- `src/main/android/streamHost.ts`: caches last CONFIG packet bytes and
  replays them to each new client; sends JSON `codec` on join; tickets
  carry served size once meta arrived; cache cleared on stop.
- `src/renderer/src/androidStream.ts`: JSON `codec` clears
  `expectCodecMeta` so the binary parser skips the missed prefix.
- `src/main/android/adb.ts`: in-process `claimedConsolePorts` registry +
  `releaseEmulatorPorts()`; allocator skips claimed pairs.
- `src/main/android/instance.ts`: `stop()` releases the console port.
- `src/renderer/src/pages/AndroidWindow.tsx`: poller reads ticket via
  ref; stale comment replaced.
- `tests/unit/androidScrcpyProtocol.test.ts`: +2 port-registry tests.
- Release: 4 version carriers 0.6.74 → 0.6.75, CHANGELOG section.

## Acceptance check

- Live late-join: early client drains 8 s, late ticket reports
  408x912, late client receives JSON codec + binary CONFIG first
  (`size=32 cfg=1`) — decoder can configure immediately.
- Live ports: 3 concurrent allocations → 5554,5556,5558, no collision;
  release + realloc reuses the freed pair.
- `tsc` main + renderer clean; `npm run build` ok; full `npm test`
  196 files / 1783 passed; `sbom:verify` ok; `cargo test` 58/58.
- Released: `main` + tag `v0.6.75` pushed; CI `refs/tags/v*` builds.
