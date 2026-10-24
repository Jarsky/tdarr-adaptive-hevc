# Changelog

## v8.0.0 — 2026-10-24

First release of the adaptive flow, replacing the v7 four-flow set.

### Added
- **Quality Report**: per-file CRF/CQ from sample encodes (size + SSIM). Brackets the target and interpolates on the
  measured size curve (up to 5 rounds); when unconverged it uses the interpolated value and lets Verify confirm.
- **Source Profile**: codec, bits-per-pixel quality class with codec-efficiency adjustment, HDR10/HLG/Dolby Vision,
  interlace detection (field order, else `idet`), conform needs. Skips already-lean sources.
- Whole-file size rules for every source type: target 50%, minimum 40%, skip above 80%; SSIM floor 0.975.
- CPU/GPU choice as a visible branch (`v8_encoder`, default CPU), using Tdarr's NVENC check. HDR always takes the CPU.
- Verify step with a bounded retry loop (`v8_max_retries`, default 1) that corrects the CRF from the real result.
- HDR10/HLG metadata passthrough to x265 (`master-display`, `max-cll`); VBV cap at the source video bitrate.
- Conforming inside the single encode: deinterlace, timestamp regeneration, even dimensions, text subtitles → SRT,
  unsupported subtitles dropped, PCM → FLAC, data/cover art dropped, fonts kept, MKV.
- Tunable library/global variables: `v8_target_ratio`, `v8_min_ratio`, `v8_max_ratio`, `v8_ssim_floor`,
  `v8_max_retries`, `v8_encoder`.
- Build (`tools/build_flows.py`) and deploy (`tools/deploy.sh`) tooling, and test harnesses.

### Fixed (compared with v7)
- v7's adaptive-CRF and subtitle-detection steps never ran: their code was stored under `jsCode`, which Tdarr's
  Custom Function plugin ignores, so every file encoded at the default CRF 25 and subtitles were always copied.
- v7's CRF brackets gave the leanest sources the lowest CRF, which inflated them (outputs of 150–260% were common).
- v7's separate Conform pass is gone: one encode per file, and the original is replaced only at the end.
- v7 retried up to three extra full encodes on a 40–80% size window; v8 sizes the encode up front and retries at most
  once (configurable) with a measured correction.
- Stale MKV `BPS` bitrate tags no longer mislead the source assessment.
