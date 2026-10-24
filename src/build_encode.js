// Adaptive HEVC — build the single encode command (flow 2, after "Begin FFmpeg Command").
// Everything v7's separate Conform pass did, plus the conform needs found by Source Profile, in one encode:
//   video: libx265 CRF (CPU) or hevc_nvenc CQ (GPU) at the Quality Report's value, 10-bit, same
//          arguments as the report's samples; deinterlace / even-crop filter when needed
//   input: regenerate timestamps for AVI / MPEG-PS / TS sources
//   audio: copy, except PCM variants MKV can't hold -> FLAC
//   subtitles: mov_text/webvtt/text -> SRT, image + SRT/ASS copied, unsupported dropped
//   data streams and cover art dropped, fonts kept | order video, audio, subtitle, attachment | MKV
module.exports = async (args) => {
  const cmd = args.variables.ffmpegCommand;
  const user = args.variables.user || {};
  const log = (m) => args.jobLog(`[build encode] ${m}`);
  const q = user.encode_quality;
  if (!q) throw new Error('encode_quality is not set - the Quality Report (flow 1) did not run');
  const nvenc = user.encoder === 'hevc_nvenc';
  const vKbps = parseFloat(user.src_kbps) || 0;

  const toSrt = ['mov_text', 'webvtt', 'text', 'tx3g'];
  const copySubs = ['subrip', 'srt', 'ass', 'ssa', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];
  const flacAudio = String(user.conform_audio_flac || '').split(',').filter(Boolean).map(Number);
  const rank = { video: 0, audio: 1, subtitle: 2, attachment: 3 };
  let videoSet = false;
  const notes = [];

  for (const s of cmd.streams) {
    const type = s.codec_type;
    const coverArt = s.disposition && Number(s.disposition.attached_pic) === 1;
    if (type === 'video' && !coverArt && !videoSet) {
      videoSet = true;
      if (user.conform_filter) s.outputArgs.push('-filter:{outputIndex}', user.conform_filter);
      if (nvenc) {
        s.outputArgs.push('-c:{outputIndex}', 'hevc_nvenc', '-preset', 'p7', '-tune', 'hq', '-rc', 'vbr', '-cq', q, '-b:v', '0',
          '-profile:{outputIndex}', 'main10', '-pix_fmt:{outputIndex}', 'p010le');
        if (vKbps) s.outputArgs.push('-maxrate', `${Math.round(vKbps)}k`, '-bufsize', `${Math.round(vKbps * 2)}k`);
      } else {
        s.outputArgs.push('-c:{outputIndex}', 'libx265', '-crf', q, '-preset', 'slow',
          '-profile:{outputIndex}', 'main10', '-pix_fmt:{outputIndex}', 'yuv420p10le');
        if (user.x265_params) s.outputArgs.push('-x265-params', user.x265_params);
      }
    } else if (coverArt || type === 'data') {
      s.removed = true; notes.push(`drop #${s.index} ${coverArt ? 'cover art' : 'data'} (${s.codec_name || '?'})`);
    } else if (type === 'audio' && flacAudio.includes(s.index)) {
      s.outputArgs.push('-c:{outputIndex}', 'flac'); notes.push(`audio #${s.index} ${s.codec_name} -> flac`);
    } else if (type === 'subtitle') {
      if (toSrt.includes(s.codec_name)) { s.outputArgs.push('-c:{outputIndex}', 'srt'); notes.push(`sub #${s.index} ${s.codec_name} -> srt`); }
      else if (!copySubs.includes(s.codec_name)) { s.removed = true; notes.push(`drop #${s.index} subtitle ${s.codec_name || 'unknown'} (not muxable to MKV)`); }
    }
  }
  if (!videoSet) throw new Error('no video stream to encode');

  if (user.conform_genpts === 'true') cmd.overallInputArguments.push('-fflags', '+genpts');
  cmd.streams.sort((a, b) => (rank[a.codec_type] ?? 9) - (rank[b.codec_type] ?? 9));
  cmd.container = 'mkv';
  cmd.shouldProcess = true;
  cmd.overallOuputArguments.push('-max_muxing_queue_size', '9999');
  log(`attempt ${user.encode_attempt || 1}: ${nvenc ? `NVENC CQ ${q}` : `x265 CRF ${q} slow`}, 10-bit${user.conform_filter ? `, filter ${user.conform_filter}` : ''}${user.conform_genpts === 'true' ? ', regenerate timestamps' : ''}`);
  if (notes.length) log(notes.join('; '));
  return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
