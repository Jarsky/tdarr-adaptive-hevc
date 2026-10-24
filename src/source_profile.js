// Adaptive HEVC — Source Profile (flow 1, after the HEVC/AV1 checks).
// Assesses the original before anything is encoded:
//   - codec family + efficiency, resolution, frame rate, bit depth
//   - quality as bits-per-pixel (bpp), normalised to H.264-equivalent by codec efficiency
//   - HDR10 / HLG / Dolby Vision
//   - conform needs: deinterlace (field_order, else idet on SD/legacy codecs), regenerate timestamps
//     (AVI / MPEG-PS / TS), even dimensions, audio MKV can't hold (-> FLAC), subtitles to drop
// Output 1 = encode candidate (variables set), 2 = skip (keep original; reason logged)
const { execFile } = require('child_process');

// How efficient each source codec is relative to H.264 (higher = more efficient). Used to scale
// both the "is it already lean?" test and the size targets: MPEG-2 at 25% of its size is about as
// "far" as H.264 at 50%.
const EFFICIENCY = { mpeg1video: 0.45, mpeg2video: 0.5, msmpeg4v2: 0.55, msmpeg4v3: 0.6, mpeg4: 0.65, wmv1: 0.6, wmv2: 0.65,
  wmv3: 0.8, vc1: 0.85, vp8: 0.9, h264: 1.0, vp9: 1.4 };
const LEAN_BPP = 0.045;   // H.264-equivalent bits/pixel below which a source is already lean (≈2.5 Mbps 1080p24)
const LEGACY = ['mpeg1video', 'mpeg2video', 'mpeg4', 'msmpeg4v2', 'msmpeg4v3', 'wmv1', 'wmv2', 'wmv3', 'vc1'];
const MKV_PCM_OK = ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_s16be', 'pcm_u8'];

function run(bin, argv) {
  return new Promise((resolve, reject) => execFile(bin, argv, { maxBuffer: 64 * 1024 * 1024 },
    (e, out, err) => (e ? reject(Object.assign(e, { stderr: String(err) })) : resolve({ stdout: String(out), stderr: String(err) }))));
}
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const fps = (r) => { const [a, b] = String(r || '0/1').split('/').map(Number); return b ? a / b : 0; };

module.exports = async (args) => {
  const user = (args.variables.user = args.variables.user || {});
  const log = (m) => args.jobLog(`[source profile] ${m}`);
  const ffprobe = args.ffProbePath || 'tdarr-ffprobe';
  const ffmpeg = args.ffmpegPath || 'tdarr-ffmpeg';
  const file = args.inputFileObj._id;
  const skip = (why) => { user.report_decision = `skip: ${why}`; log(`SKIP - ${why}`); return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables }; };

  const info = JSON.parse((await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])).stdout);
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && Number(s.disposition.attached_pic) === 1));
  if (!v) return skip('no video stream');
  const codec = v.codec_name;
  if (['hevc', 'av1'].includes(codec)) return skip(`already ${codec}`);
  if ((v.side_data_list || []).some((s) => /DOVI/i.test(s.side_data_type || ''))) return skip('Dolby Vision (re-encoding would drop the DV layer)');

  const container = String(info.format.format_name || '');
  const duration = num(info.format.duration) || num(v.duration);
  const width = num(v.width); const height = num(v.height);
  const rate = fps(v.avg_frame_rate) || fps(v.r_frame_rate) || 24;
  const fileBytes = num(info.format.size);
  // Video bitrate: per-stream tags (MKV "BPS" statistics) can be stale when a tool re-encoded the file
  // but copied the old tags, so cross-check them against the real size/duration and fall back to
  // "total minus the other streams" when they disagree.
  const totalKbps = duration ? (fileBytes * 8 / 1000) / duration : 0;
  const streamKbps = (s) => (num(s.bit_rate) || num(s.tags && (s.tags.BPS || s.tags['BPS-eng']))) / 1000;
  const otherKbps = Math.min(totalKbps * 0.6, streams.filter((s) => s !== v).reduce((a, s) => a + streamKbps(s), 0));
  const sizeKbps = Math.max(0, totalKbps - otherKbps);
  let vKbps = streamKbps(v);
  if (totalKbps && (!vKbps || vKbps > totalKbps * 1.05 || vKbps < sizeKbps * 0.6)) {
    if (vKbps) log(`video bitrate tag ${vKbps.toFixed(0)} kbps disagrees with the file size (~${sizeKbps.toFixed(0)} kbps); using the size-based figure`);
    vKbps = sizeKbps;
  }
  const eff = EFFICIENCY[codec] || 0.8;
  const bpp = width && height && rate && vKbps ? (vKbps * 1000) / (width * height * rate) : 0;
  const effBpp = bpp * eff;
  const quality = !bpp ? 'unknown' : effBpp >= 0.25 ? 'high (remux/disc-like)' : effBpp >= 0.08 ? 'standard' : effBpp >= LEAN_BPP ? 'lean' : 'very lean';
  const transfer = v.color_transfer || '';
  const hdr = transfer === 'smpte2084' ? 'HDR10' : transfer === 'arib-std-b67' ? 'HLG' : 'SDR';
  log(`${codec} (${v.profile || '?'}, ${v.pix_fmt || '?'}) ${width}x${height} @ ${rate.toFixed(3)} fps in ${container}, ${(duration / 60).toFixed(1)} min`);
  log(`video ${vKbps.toFixed(0)} kbps = ${bpp.toFixed(3)} bpp (x${eff} efficiency = ${effBpp.toFixed(3)} H.264-equiv) -> quality: ${quality} | ${hdr}`);
  if (duration < 20) return skip('shorter than 20 s');
  if (bpp && effBpp < LEAN_BPP) return skip(`already lean (${effBpp.toFixed(3)} H.264-equiv bpp < ${LEAN_BPP}); re-encoding would mostly cost quality`);

  // ── conform needs ─────────────────────────────────────────────────────────
  const filters = [];
  let interlaced = ['tt', 'bb', 'tb', 'bt'].includes(v.field_order);
  let how = `field_order=${v.field_order || 'unset'}`;
  if (!interlaced && (LEGACY.includes(codec) || height <= 576) && duration > 60) {
    try {   // idet over ~600 frames from a quarter of the way in
      const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-ss', String(Math.floor(duration * 0.25)), '-i', file,
        '-map', '0:v:0', '-frames:v', '600', '-vf', 'idet', '-an', '-sn', '-f', 'null', '-']);
      const m = stderr.match(/Multi frame detection: TFF:\s*(\d+) BFF:\s*(\d+) Progressive:\s*(\d+)/);
      if (m) {
        const [tff, bff, prog] = m.slice(1).map(Number);
        interlaced = (tff + bff) > 0.3 * (tff + bff + prog);
        how = `idet TFF ${tff} / BFF ${bff} / progressive ${prog}`;
      }
    } catch (e) { how += ' (idet failed)'; }
  }
  if (interlaced) filters.push('bwdif=mode=send_frame:parity=auto:deint=all');
  if (width % 2 || height % 2) filters.push('crop=trunc(iw/2)*2:trunc(ih/2)*2');
  const genpts = /avi|mpeg|mpegts|vob|asf/.test(container);
  const audioFlac = streams.filter((s) => s.codec_type === 'audio' && /^pcm_/.test(s.codec_name) && !MKV_PCM_OK.includes(s.codec_name)).map((s) => s.index);

  user.src_codec = codec;
  user.src_efficiency = String(eff);
  user.src_kbps = String(Math.round(vKbps));
  user.src_bpp = bpp.toFixed(4);
  user.src_height = String(height);
  user.src_bytes = String(fileBytes);
  user.src_video_bytes = String(Math.round((vKbps * 1000 / 8) * duration) || Math.round(fileBytes * 0.85));
  user.src_duration = String(duration);
  user.src_audio_count = String(streams.filter((s) => s.codec_type === 'audio').length);
  user.is_hdr = hdr === 'SDR' ? 'false' : 'true';
  user.hdr_type = hdr;
  user.conform_filter = filters.join(',');
  user.conform_genpts = genpts ? 'true' : 'false';
  user.conform_audio_flac = audioFlac.join(',');
  log(`conform: interlaced=${interlaced} (${how}) | filters: ${user.conform_filter || 'none'} | regenerate timestamps: ${genpts} | audio->FLAC: ${user.conform_audio_flac || 'none'}`);
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
