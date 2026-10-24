// Adaptive HEVC — Quality Report (flow 1, after Source Profile and the CPU/GPU choice).
// Finds the encoder quality value (x265 CRF, or NVENC CQ) for THIS file by test-encoding samples:
//   1. cut 3 short samples spread through the file (stream copy)
//   2. encode them with the real settings (encoder, preset, 10-bit, conform filters)
//   3. measure size vs the source samples and SSIM (vs the source run through the same filters)
//   4. search toward the target size (log-size model, refit from measurements), never below the
//      SSIM floor and never shrinking further than the minimum; skip if not worth encoding
// Size rules are for the WHOLE FILE, the same for every source type: aim for 50% of the original,
// never below 40%, skip if it can't get under 80%. Audio/subtitles are copied, so each file's rule is
// converted to a video-stream target from how much of the file is video.
// Output 1 = encode (encode_quality etc. set), 2 = skip (keep original; reason logged)
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULTS = { fileTarget: 0.50, fileMin: 0.40, fileMax: 0.80, ssimFloor: 0.975, maxRounds: 5 };
const ENCODERS = {
  libx265: { label: 'x265 CRF', lo: 16, hi: 34, ref28Kbps: 2300 },
  hevc_nvenc: { label: 'NVENC CQ', lo: 18, hi: 38, ref28Kbps: 2900 },   // NVENC needs ~1-2 more CQ for the same size
};

function run(bin, argv) {
  return new Promise((resolve, reject) => execFile(bin, argv, { maxBuffer: 64 * 1024 * 1024 },
    (e, out, err) => (e ? reject(Object.assign(e, { stderr: String(err).slice(-2000) })) : resolve({ stdout: String(out), stderr: String(err) }))));
}
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
function userVar(args, name, dflt) {
  const lib = (args.userVariables && args.userVariables.library) || {};
  const glob = (args.userVariables && args.userVariables.global) || {};
  const val = lib[name] !== undefined && lib[name] !== '' ? lib[name] : glob[name];
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : dflt;
}

async function firstFrameSideData(ffprobe, file) {
  try {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-print_format', 'json',
      '-show_frames', '-read_intervals', '%+#1', '-show_entries', 'frame=side_data_list', file]);
    const f = (JSON.parse(stdout).frames || [])[0];
    return (f && f.side_data_list) || [];
  } catch (e) { return []; }
}

// x265 HDR10 / HLG parameters so the encode keeps the colour metadata
function hdrParams(v, side) {
  const transfer = v.color_transfer || '';
  if (transfer !== 'smpte2084' && transfer !== 'arib-std-b67') return [];
  const p = [`colorprim=${v.color_primaries || 'bt2020'}`, `transfer=${transfer}`,
    `colormatrix=${v.color_space === 'bt2020c' ? 'bt2020c' : 'bt2020nc'}`, 'repeat-headers=1'];
  if (transfer === 'smpte2084') {
    p.push('hdr10=1', 'hdr10-opt=1');
    const md = side.find((s) => /Mastering display/i.test(s.side_data_type || ''));
    const cl = side.find((s) => /Content light/i.test(s.side_data_type || ''));
    const r = (x) => { const [a, b] = String(x || '0/1').split('/').map(Number); return b ? a / b : 0; };
    if (md && md.red_x) {
      const c = (x) => Math.round(r(x) * 50000); const l = (x) => Math.round(r(x) * 10000);
      p.push(`master-display=G(${c(md.green_x)},${c(md.green_y)})B(${c(md.blue_x)},${c(md.blue_y)})R(${c(md.red_x)},${c(md.red_y)})WP(${c(md.white_point_x)},${c(md.white_point_y)})L(${l(md.max_luminance)},${l(md.min_luminance)})`);
    }
    if (cl) p.push(`max-cll=${cl.max_content || 0},${cl.max_average || 0}`);
  }
  return p;
}

// The encoder arguments used for BOTH the samples and the real encode (build_encode.js mirrors this)
function videoArgs(encoder, q, x265Params, vKbps) {
  if (encoder === 'hevc_nvenc') {
    const a = ['-c:v', 'hevc_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0',
      '-profile:v', 'main10', '-pix_fmt', 'p010le'];
    if (vKbps) a.push('-maxrate', `${Math.round(vKbps)}k`, '-bufsize', `${Math.round(vKbps * 2)}k`);
    return a;
  }
  return ['-c:v', 'libx265', '-preset', 'slow', '-crf', String(q), '-pix_fmt', 'yuv420p10le', '-profile:v', 'main10',
    '-x265-params', ['log-level=error', ...x265Params].join(':')];
}

module.exports = async (args) => {
  const user = (args.variables.user = args.variables.user || {});
  const log = (m) => args.jobLog(`[quality report] ${m}`);
  const ffmpeg = args.ffmpegPath || 'tdarr-ffmpeg';
  const ffprobe = args.ffProbePath || 'tdarr-ffprobe';
  const file = args.inputFileObj._id;
  const skip = (why) => { user.report_decision = `skip: ${why}`; log(`SKIP - ${why}`); return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables }; };
  if (!user.src_codec) throw new Error('Source Profile has not run (src_codec unset)');

  // encoder: chosen by the CPU/GPU branch; HDR always goes to x265 so its metadata survives
  let encoder = user.encoder === 'hevc_nvenc' ? 'hevc_nvenc' : 'libx265';
  if (encoder === 'hevc_nvenc' && user.is_hdr === 'true') { encoder = 'libx265'; log(`${user.hdr_type} source: using CPU x265 instead of NVENC to keep HDR metadata`); }
  user.encoder = encoder;
  const enc = ENCODERS[encoder];

  // whole-file rules -> video-stream targets (non-video bytes are copied unchanged)
  const fileTarget = userVar(args, 'v8_target_ratio', DEFAULTS.fileTarget);
  const fileMin = userVar(args, 'v8_min_ratio', DEFAULTS.fileMin);
  const fileMax = userVar(args, 'v8_max_ratio', DEFAULTS.fileMax);
  const fileBytes = num(user.src_bytes); const vBytes = num(user.src_video_bytes) || fileBytes * 0.85;
  const other = fileBytes ? Math.max(0, Math.min(0.9, (fileBytes - vBytes) / fileBytes)) : 0.15;   // share of file that isn't video
  const toVideo = (f) => (f - other) / (1 - other);
  const toFile = (r) => other + (1 - other) * r;
  const cfg = {
    ...DEFAULTS,
    targetRatio: Math.max(0.15, toVideo(fileTarget)),
    minRatio: Math.max(0.10, toVideo(fileMin)),
    ssimFloor: userVar(args, 'v8_ssim_floor', DEFAULTS.ssimFloor),
  };
  const vKbps = num(user.src_kbps);
  const height = num(user.src_height) || 1080;
  const duration = num(user.src_duration);

  const info = JSON.parse((await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', file])).stdout);
  const v = (info.streams || [])[0] || {};
  const x265Params = encoder === 'libx265' ? hdrParams(v, await firstFrameSideData(ffprobe, file)) : [];
  if (encoder === 'libx265' && vKbps) x265Params.push(`vbv-maxrate=${Math.round(vKbps)}`, `vbv-bufsize=${Math.round(vKbps * 2)}`);   // never above source bitrate
  const filter = user.conform_filter || '';
  const genpts = user.conform_genpts === 'true' ? ['-fflags', '+genpts'] : [];

  const ref = enc.ref28Kbps * Math.pow((height / 1080) ** 2, 0.75);
  const guess = vKbps ? 28 + 6 * Math.log2(ref / (vKbps * cfg.targetRatio)) : (enc.lo + enc.hi) / 2;
  const clampQ = (q) => Math.max(enc.lo, Math.min(enc.hi, Math.round(q)));
  log(`${enc.label} search: whole file target ${(fileTarget * 100).toFixed(0)}% (min ${(fileMin * 100).toFixed(0)}%, skip above ${(fileMax * 100).toFixed(0)}%) = video ${(cfg.targetRatio * 100).toFixed(0)}% (min ${(cfg.minRatio * 100).toFixed(0)}%; ${(other * 100).toFixed(0)}% of the file is audio/subs), SSIM floor ${cfg.ssimFloor}, first guess ${clampQ(guess)}${filter ? `, filters ${filter}` : ''}`);

  // ── samples ───────────────────────────────────────────────────────────────
  const work = path.join(args.workDir, 'quality-report');
  fs.mkdirSync(work, { recursive: true });
  const n = duration < 180 ? 1 : 3;
  const len = Math.min(duration < 180 ? duration * 0.5 : (height > 1600 ? 6 : 8), 30);
  const src = [];
  for (let i = 0; i < n; i += 1) {
    const at = n === 1 ? duration * 0.1 : duration * (0.15 + (0.7 * i) / (n - 1));
    const out = path.join(work, `src${i}.mkv`);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...genpts, '-ss', at.toFixed(2), '-i', file, '-t', len.toFixed(2),
      '-map', '0:v:0', '-c', 'copy', '-an', '-sn', out]);
    src.push(out);
  }
  const srcBytes = src.reduce((a, f) => a + fs.statSync(f).size, 0);

  // ── search ────────────────────────────────────────────────────────────────
  const tried = [];
  const measure = async (q) => {
    const t0 = Date.now(); let bytes = 0; const ss = [];
    for (let i = 0; i < src.length; i += 1) {
      const out = path.join(work, `enc${i}_q${q}.mkv`);
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src[i], '-map', '0:v:0', ...(filter ? ['-vf', filter] : []),
        ...videoArgs(encoder, q, x265Params, vKbps), '-an', '-sn', out]);
      bytes += fs.statSync(out).size;
      const refChain = `${filter ? `${filter},` : ''}format=yuv420p10le`;
      const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', out, '-i', src[i], '-lavfi',
        `[0:v]format=yuv420p10le[a];[1:v]${refChain}[b];[a][b]ssim`, '-f', 'null', '-']);
      const m = stderr.match(/SSIM Y:([0-9.]+)/);
      if (m) ss.push(parseFloat(m[1]));
    }
    const r = { q, ratio: bytes / srcBytes, ssim: ss.length ? ss.reduce((a, b) => a + b, 0) / ss.length : null };
    tried.push(r);
    log(`round ${tried.length}: ${enc.label} ${q} -> video ${(r.ratio * 100).toFixed(1)}% of source, SSIM ${r.ssim === null ? 'n/a' : r.ssim.toFixed(4)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    return r;
  };
  // ── search: bracket the target, then interpolate on the measured size curve ───────────────
  // Size curves differ a lot (lean WEB ~6 CRF per halving; grainy Blu-ray can be ~2-3), so after the
  // first measurement the next guess comes from measured points. A result pinned at the VBV cap (>95%)
  // only says "too big". A CRF that fails the SSIM floor caps every later guess below it.
  const capped = (t) => t.ratio > 0.95;
  const qualityOk = (t) => t.ssim === null || t.ssim >= cfg.ssimFloor;
  const onTarget = (t) => Math.abs(toFile(t.ratio) - fileTarget) <= 0.05 && t.ratio >= cfg.minRatio;
  const bracket = () => ({
    big: tried.filter((t) => t.ratio > cfg.targetRatio).sort((a, b) => b.q - a.q)[0],     // highest q still too big
    small: tried.filter((t) => t.ratio <= cfg.targetRatio).sort((a, b) => a.q - b.q)[0],  // lowest q already small enough
  });
  const between = (big, small, r) => big.q + (small.q - big.q) * Math.log(big.ratio / r) / Math.log(big.ratio / small.ratio);
  const slope = () => {   // quality steps per halving of size: bracket if we have one, else uncapped points, else 6
    const { big, small } = bracket();
    if (big && small && !capped(big) && small.q > big.q) return Math.max(1.5, Math.min(12, (small.q - big.q) / Math.log2(big.ratio / small.ratio)));
    const u = tried.filter((t) => !capped(t));
    if (u.length < 2) return 6;
    const [a, b] = u.slice(-2); const d = Math.log2(a.ratio / b.ratio);
    return Math.abs(d) > 0.05 ? Math.max(1.5, Math.min(12, (b.q - a.q) / d)) : 6;
  };

  let qCeil = enc.hi;
  let cur = await measure(clampQ(guess));
  for (;;) {
    if (!qualityOk(cur)) qCeil = Math.min(qCeil, cur.q - 1);
    if (qualityOk(cur) && onTarget(cur)) break;
    if (tried.length >= cfg.maxRounds) break;
    const { big, small } = bracket();
    let next;
    if (big && small) next = between(big, small, cfg.targetRatio);
    else if (big) next = big.q + Math.max(capped(big) ? 4 : 1, slope() * Math.log2(big.ratio / cfg.targetRatio));
    else next = small.q - Math.max(1, slope() * Math.log2(cfg.targetRatio / small.ratio));
    next = clampQ(next);
    if (big && small) next = Math.max(big.q + 1, Math.min(small.q - 1, next));   // stay inside the bracket
    next = Math.min(next, qCeil);
    if (next < enc.lo) break;                     // quality floor can't be met inside the allowed range
    next = clampQ(next);
    if (tried.some((t) => t.q === next)) break;   // bracket closed: nothing new to learn
    cur = await measure(next);
  }
  fs.rmSync(work, { recursive: true, force: true });

  // choose: closest to target among measured points that pass quality and the minimum
  const valid = tried.filter((t) => qualityOk(t) && t.ratio >= cfg.minRatio);
  let best = valid.length ? valid.reduce((a, b) => (Math.abs(toFile(b.ratio) - fileTarget) < Math.abs(toFile(a.ratio) - fileTarget) ? b : a)) : null;
  let estimated = false;
  const { big, small } = bracket();
  // not converged but the target is bracketed: use the interpolated value; Verify measures the real
  // result and can retry once, which is far better than skipping or taking a distant point
  if ((!best || !onTarget(best)) && big && small && small.q - big.q > 1) {
    const q = Math.min(qCeil, Math.max(big.q + 1, Math.min(small.q - 1, Math.round(between(big, small, cfg.targetRatio)))));
    const t = (q - big.q) / (small.q - big.q);
    best = { q, ratio: Math.exp(Math.log(big.ratio) + t * (Math.log(small.ratio) - Math.log(big.ratio))), ssim: small.ssim };
    estimated = true;
  }
  if (!best) {
    const lowest = tried.reduce((a, b) => (b.q < a.q ? b : a));
    if (lowest.ratio < cfg.minRatio && lowest.q <= enc.lo + 1) return skip(`even ${enc.label} ${enc.lo} shrinks the file to ~${(toFile(lowest.ratio) * 100).toFixed(0)}% (rule: never below ${(fileMin * 100).toFixed(0)}%)`);
    return skip(`no ${enc.label} value met the SSIM floor ${cfg.ssimFloor} at a useful size`);
  }
  const predicted = Math.min(1, toFile(best.ratio));
  if (predicted > fileMax) return skip(`best quality-safe ${enc.label} ${best.q} only gets the file to ~${(predicted * 100).toFixed(0)}% (skip above ${(fileMax * 100).toFixed(0)}%)`);
  if (estimated) log(`not converged in ${tried.length} rounds; target bracketed by ${enc.label} ${big.q} (${(big.ratio * 100).toFixed(0)}%) and ${small.q} (${(small.ratio * 100).toFixed(0)}%) -> interpolated ${best.q}; Verify will confirm`);
  Object.assign(user, {
    encode_quality: String(best.q), encode_attempt: '1', x265_params: x265Params.join(':'),
    report_target: cfg.targetRatio.toFixed(3), report_min: cfg.minRatio.toFixed(3), report_slope: slope().toFixed(2),
    report_file_target: fileTarget.toFixed(3), report_file_min: fileMin.toFixed(3),
    report_q_lo: String(enc.lo), report_q_hi: String(enc.hi),
    report_video_ratio: best.ratio.toFixed(3), report_file_ratio: predicted.toFixed(3),
    report_ssim: best.ssim === null ? '' : best.ssim.toFixed(4), report_decision: 'encode',
  });
  log(`DECISION: ${enc.label} ${best.q}${estimated ? ' (interpolated)' : ''} | video ~${(best.ratio * 100).toFixed(0)}% | whole file ~${(predicted * 100).toFixed(0)}% | SSIM ${user.report_ssim || 'n/a'}${estimated ? ' (nearest measured)' : ''}`);
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
