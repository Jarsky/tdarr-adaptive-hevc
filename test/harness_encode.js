// End-to-end check of v8 flows 2+3 outside Tdarr: node harness_encode.js <clip> <crf> [x265_params]
// Mirrors ffmpegCommandStart -> build_encode -> ffmpegCommandExecute (CLI assembly) -> verify.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const [clip, crf, x265] = process.argv.slice(2);
const work = `/temp/v8enc-${Date.now()}`;
fs.mkdirSync(work, { recursive: true });
const log = (m) => console.log(m);
const info = JSON.parse(execFileSync('tdarr-ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', clip]));

// ffmpegCommandStart
const cmd = { init: true, inputFiles: [], container: path.extname(clip).slice(1), shouldProcess: false, overallInputArguments: [], overallOuputArguments: [],
  streams: info.streams.map((s) => ({ ...s, codec_type: s.disposition && s.disposition.attached_pic ? 'attachment' : s.codec_type, removed: false, mapArgs: ['-map', `0:${s.index}`], inputArgs: [], outputArgs: [] })) };
const vOnly = path.join(work, 'v.mkv');
execFileSync('tdarr-ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip, '-map', '0:v:0', '-c', 'copy', vOnly]);
const user = { encode_quality: crf, encoder: process.env.ENCODER || 'libx265', x265_params: x265 || '', encode_attempt: '1',
  src_bytes: String(fs.statSync(clip).size), src_video_bytes: String(fs.statSync(vOnly).size), src_duration: info.format.duration,
  src_audio_count: String(info.streams.filter((s) => s.codec_type === 'audio').length), src_kbps: '0',
  report_target: '0.5', report_min: '0.35', report_slope: '6', report_q_lo: '16', report_q_hi: '34', report_file_ratio: '0',
  conform_filter: '', conform_genpts: 'false', conform_audio_flac: '' };
const args = { inputFileObj: { _id: clip }, variables: { ffmpegCommand: cmd, user }, jobLog: log, userVariables: { library: {}, global: {} } };

(async () => {
  await require(path.join(__dirname, '..', 'src', 'build_encode.js'))(args);
  // ffmpegCommandExecute CLI assembly
  const streams = cmd.streams.filter((s) => !s.removed);
  const cli = ['-y', '-i', clip];
  streams.forEach((s, i) => {
    const typeIdx = streams.filter((x, j) => j < i && x.codec_type === s.codec_type).length;
    const outArgs = s.outputArgs.map((a) => a.replace('{outputIndex}', i).replace('{outputTypeIndex}', typeIdx));
    cli.push(...s.mapArgs);
    if (!outArgs.some((a) => a.startsWith('-c:'))) cli.push(`-c:${i}`, 'copy');
    cli.push(...outArgs);
  });
  cli.push(...cmd.overallOuputArguments);
  const out = path.join(work, `${path.basename(clip, path.extname(clip))}.${cmd.container}`);
  cli.push(out);
  log(`ffmpeg ${cli.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  const t0 = Date.now();
  execFileSync('tdarr-ffmpeg', ['-hide_banner', '-loglevel', 'error', ...cli], { stdio: ['ignore', 'ignore', 'pipe'] });
  log(`encode took ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const outInfo = JSON.parse(execFileSync('tdarr-ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', out]));
  log(`output streams: ${outInfo.streams.map((s) => `${s.index}:${s.codec_type}/${s.codec_name}`).join(' ')}`);
  const ov = outInfo.streams.find((s) => s.codec_type === 'video') || {};
  const side = JSON.parse(execFileSync('tdarr-ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-print_format', 'json', '-show_frames',
    '-read_intervals', '%+#1', '-show_entries', 'frame=side_data_list', out])).frames[0] || {};
  log(`output video: ${ov.codec_name} ${ov.profile} ${ov.pix_fmt} transfer=${ov.color_transfer} primaries=${ov.color_primaries} matrix=${ov.color_space} | side data: ${(side.side_data_list || []).map((d) => d.side_data_type).join(', ') || 'none'}`);
  args.inputFileObj = { _id: out };
  const r = await require(path.join(__dirname, '..', 'src', 'verify.js'))(args);
  log(`verify -> output ${r.outputNumber}${r.outputNumber === 3 ? ` (retry with ${user.encode_quality}, attempt ${user.encode_attempt})` : ''}`);
  fs.rmSync(work, { recursive: true, force: true });
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
