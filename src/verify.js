// Adaptive HEVC — verify the encode before anything replaces the original (flow 3).
// Output 1 = good -> replace + notify
// Output 2 = keep original (broken encode, or still out of range after the allowed retries)
// Output 3 = retry: re-encode once more with a corrected quality value (counter: encode_attempt,
//            limit: v8_max_retries, default 1). The correction uses the REAL full-file result, so a
//            single retry is normally enough.
const { execFile } = require('child_process');
const fs = require('fs');

// Whole-file window (target 50%, never below 40%): retry outside 37-70%; after the retries a file
// between 70% and 85% is still accepted (it saved space), anything else keeps the original.
const RETRY_ABOVE = 0.70;      // further from the 50% target than the samples should ever miss by
const ACCEPT_UP_TO = 0.85;     // after retries: still worth replacing if it saves 15%+
const GRACE = 0.03;            // sample-based estimates: allow 37% before calling it "below 40%"
const BROKEN_BELOW = 0.10;     // smaller than this is a broken encode, not "too good"

function probe(ffprobe, file) {
  return new Promise((resolve, reject) => execFile(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { maxBuffer: 32 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(JSON.parse(String(out))))));
}
function userVar(args, name, dflt) {
  const lib = (args.userVariables && args.userVariables.library) || {};
  const glob = (args.userVariables && args.userVariables.global) || {};
  const n = parseFloat(lib[name] !== undefined && lib[name] !== '' ? lib[name] : glob[name]);
  return Number.isFinite(n) ? n : dflt;
}

module.exports = async (args) => {
  const user = args.variables.user || {};
  const log = (m) => args.jobLog(`[verify] ${m}`);
  const ffprobe = args.ffProbePath || 'tdarr-ffprobe';
  const result = (n) => ({ outputFileObj: args.inputFileObj, outputNumber: n, variables: args.variables });
  const keep = (why) => { log(`KEEP ORIGINAL - ${why}`); return result(2); };

  const out = args.inputFileObj._id;
  const outBytes = fs.statSync(out).size;
  const srcBytes = parseFloat(user.src_bytes) || 0;
  const srcVideo = parseFloat(user.src_video_bytes) || srcBytes * 0.85;
  const info = await probe(ffprobe, out);
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).filter((s) => s.codec_type === 'audio').length;
  const dur = parseFloat(info.format.duration) || 0;
  const srcDur = parseFloat(user.src_duration) || 0;

  // integrity: never retried, the problem isn't the quality value
  if (!v || v.codec_name !== 'hevc') return keep(`output video is ${v ? v.codec_name : 'missing'}, expected hevc`);
  if (srcDur && Math.abs(dur - srcDur) > Math.max(2, srcDur * 0.005)) return keep(`duration ${dur.toFixed(1)} s vs source ${srcDur.toFixed(1)} s (truncated encode?)`);
  if (user.src_audio_count && audio !== parseInt(user.src_audio_count, 10)) return keep(`${audio} audio tracks vs ${user.src_audio_count} in source`);
  if (!srcBytes) return keep('source size unknown');

  const fileRatio = outBytes / srcBytes;
  const videoRatio = Math.max(0.001, (outBytes - (srcBytes - srcVideo)) / srcVideo);   // audio/subs are copied
  const target = parseFloat(user.report_target) || 0.5;   // video-stream target (for the correction maths)
  const fileMin = parseFloat(user.report_file_min) || 0.40;
  const attempt = parseInt(user.encode_attempt || '1', 10);
  const maxRetries = userVar(args, 'v8_max_retries', 1);
  const q = parseInt(user.encode_quality, 10);
  log(`attempt ${attempt}: file ${(fileRatio * 100).toFixed(1)}% of original (report predicted ~${(parseFloat(user.report_file_ratio || 0) * 100).toFixed(0)}%, target ${(parseFloat(user.report_file_target || 0.5) * 100).toFixed(0)}%, min ${(fileMin * 100).toFixed(0)}%) at ${user.encoder === 'hevc_nvenc' ? 'CQ' : 'CRF'} ${q}`);

  if (fileRatio < BROKEN_BELOW) return keep(`output is suspiciously small (${(fileRatio * 100).toFixed(1)}%)`);
  const tooFar = fileRatio < fileMin - GRACE;
  const tooBig = fileRatio > RETRY_ABOVE;
  if (!tooBig && !tooFar) { user.result_file_ratio = fileRatio.toFixed(3); log('OK'); return result(1); }

  const why = tooBig ? `file is ${(fileRatio * 100).toFixed(1)}%, well above the 50% target` : `shrank too far (${(fileRatio * 100).toFixed(1)}% < ${(fileMin * 100).toFixed(0)}% minimum)`;
  if (attempt > maxRetries) {
    if (tooBig && fileRatio <= ACCEPT_UP_TO) { user.result_file_ratio = fileRatio.toFixed(3); log(`ACCEPT - ${why}, but retries are used up and it still saves ${((1 - fileRatio) * 100).toFixed(0)}%`); return result(1); }
    return keep(`${why}; ${attempt - 1} retr${attempt - 1 === 1 ? 'y' : 'ies'} used (limit ${maxRetries})`);
  }

  // corrected quality from the real result: ~slope steps per halving of size
  const slope = parseFloat(user.report_slope) || 6;
  const lo = parseInt(user.report_q_lo || '16', 10); const hi = parseInt(user.report_q_hi || '34', 10);
  let next = Math.round(q + slope * Math.log2(videoRatio / target));
  if (next === q) next = tooBig ? q + 1 : q - 1;
  next = Math.max(lo, Math.min(hi, next));
  if (next === q) return keep(`${why}; quality value already at its limit (${q})`);
  user.encode_quality = String(next);
  user.encode_attempt = String(attempt + 1);
  log(`RETRY ${attempt}/${maxRetries} - ${why}; ${q} -> ${next}`);
  return result(3);
};
