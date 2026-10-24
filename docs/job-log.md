# Reading the job log

Every decision the flow makes is written to the Tdarr job report with one of four prefixes. Search the report for the
prefix to follow a file through the flow.

## `[source profile]` (flow 1)

```text
[source profile] h264 (High, yuv420p) 1920x1080 @ 23.976 fps in matroska,webm, 46.3 min
[source profile] video 5761 kbps = 0.116 bpp (x1 efficiency = 0.116 H.264-equiv) -> quality: standard | SDR
[source profile] conform: interlaced=false (field_order=progressive) | filters: none | regenerate timestamps: false | audio->FLAC: none
```

- **bpp**: bits per pixel per frame, the size-independent measure of how much data the source spends on its picture.
- **efficiency**: how good the source codec is relative to H.264 (MPEG-2 0.5, XviD 0.65, VC-1 0.85, H.264 1.0). The
  H.264-equivalent bpp decides the quality class: *high* ≥ 0.25, *standard* ≥ 0.08, *lean* ≥ 0.045, *very lean* below
  that (skipped).
- **conform**: what the encode will fix: deinterlacing (and how it was detected), timestamp regeneration, audio that
  must become FLAC.
- `video bitrate tag … disagrees with the file size`: the file carries a stale MKV bitrate tag (common after a re-encode
  that copied old tags). The size-based figure is used instead.

Skip reasons: `already hevc` / `already av1` · `Dolby Vision` · `already lean (… bpp < 0.045)` · `shorter than 20 s` ·
`no video stream`.

## `[quality report]` (flow 1)

```text
[quality report] x265 CRF search: whole file target 50% (min 40%, skip above 80%) = video 46% (min 35%; 7% of the file is audio/subs), SSIM floor 0.975, first guess 27
[quality report] round 1: x265 CRF 27 -> video 14.2% of source, SSIM 0.9802 (189 s)
[quality report] round 2: x265 CRF 17 -> video 106.7% of source, SSIM 0.9850 (271 s)
[quality report] round 3: x265 CRF 21 -> video 45.2% of source, SSIM 0.9828 (236 s)
[quality report] DECISION: x265 CRF 21 | video ~45% | whole file ~49% | SSIM 0.9828
```

- The first line converts the whole-file rules into video targets for this file (audio and subtitles are copied).
- Each round is one candidate CRF tested on all samples: the video size relative to the same source samples, and the
  average SSIM.
- A result above ~95% means the encode hit the bitrate cap (it would have been bigger than the source).
- `not converged … interpolated N; Verify will confirm`: the rounds ran out with the target bracketed, so the CRF was
  interpolated between the two nearest measurements. Verify measures the real result.
- `… using CPU x265 instead of NVENC to keep HDR metadata`: GPU was requested but the source is HDR.

Skip reasons: `best quality-safe CRF N only gets the file to ~X% (skip above 80%)` (can't shrink enough without losing
quality) · `even CRF 16 shrinks the file to ~X% (rule: never below 40%)` (very compressible source, usually one that
was padded with bitrate) · `no CRF value met the SSIM floor at a useful size`.

## `[build encode]` (flow 2)

```text
[build encode] attempt 1: x265 CRF 21 slow, 10-bit, filter bwdif=mode=send_frame:parity=auto:deint=all, regenerate timestamps
[build encode] sub #2 mov_text -> srt; drop #3 data (bin_data)
```

The attempt number, the encoder and quality value, any filters, and every stream that was converted or dropped.

## `[verify]` (flow 3)

```text
[verify] attempt 1: file 45.2% of original (report predicted ~47%, target 50%, min 40%) at CRF 20
[verify] OK
```

| Outcome | Meaning |
|---|---|
| `OK` | 37–70% of the original and intact → flow 4 replaces the original |
| `RETRY 1/1 - …; 30 -> 24` | Outside the window: re-encode with the corrected CRF (`v8_max_retries`) |
| `ACCEPT - …` | Retries used, still 70–85%: replaced anyway because it saves space |
| `KEEP ORIGINAL - …` | Broken output (not HEVC, wrong duration, missing audio tracks, < 10%) or still outside the window after the retries |
