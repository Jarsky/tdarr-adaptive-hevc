// Runs v8 flow-1 custom functions in sequence outside Tdarr, like the flow does:
//   node harness.js <file> <step.js> [step.js ...]     (env ENCODER=libx265|hevc_nvenc, default libx265;
//   V8_VARS='{"v8_min_ratio":"0.1"}' sets library variables)
// Stops at the first step that returns output 2 (skip). Prints the variables at the end.
const fs = require('fs');
const [file, ...steps] = process.argv.slice(2);
const work = `/temp/v8test-${Date.now()}`;
fs.mkdirSync(work, { recursive: true });
const args = {
  inputFileObj: { _id: file, file_size: fs.statSync(file).size / 1e9 },
  variables: { user: { encoder: process.env.ENCODER || 'libx265' } }, userVariables: { library: JSON.parse(process.env.V8_VARS || '{}'), global: {} },
  jobLog: (m) => console.log(new Date().toISOString().slice(11, 19), m),
  workDir: work, ffmpegPath: 'tdarr-ffmpeg',
};
(async () => {
  const t0 = Date.now();
  for (const s of steps) {
    const r = await require(s)(args);
    if (r.outputNumber !== 1) { console.log(`=> ${s.split('/').pop()} returned output ${r.outputNumber}`); break; }
  }
  console.log(`=> done in ${((Date.now() - t0) / 1000).toFixed(0)} s`, JSON.stringify(args.variables.user));
  fs.rmSync(work, { recursive: true, force: true });
})().catch((e) => { console.error('ERROR', e.message, e.stderr || ''); process.exit(1); });
