"""Generate the four Tdarr flows from the sources in src/ -> flows/.

Usage:  python3 tools/build_flows.py          (needs Python 3.8+; PyYAML for the .yml exports)

Writes, per flow, an importable "N - Name.yml" and "N - Name.json" (one Tdarr flow document each),
plus flows/all-flows.json (the four documents, used by tools/deploy.sh).
The custom-function JavaScript is embedded under the `code` input, the field Tdarr's
customFunction plugin actually reads.
"""
import copy
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
OUT = os.path.join(ROOT, "flows")
code = {n: open(os.path.join(SRC, f"{n}.js")).read() for n in ("source_profile", "quality_report", "build_encode", "verify")}
notify_template = json.load(open(os.path.join(SRC, "templates", "notify_flow.json")))


def node(nid, name, plugin, version="1.0.0", inputs=None, x=760, y=0):
    return {"name": name, "sourceRepo": "Community", "pluginName": plugin, "version": version,
            "inputsDB": inputs, "fpEnabled": True, "id": nid, "position": {"x": x, "y": y}}


def edges(pairs):
    return [{"id": f"e{i}", "source": s, "sourceHandle": str(h), "target": t, "animated": True, "type": "smoothstep"}
            for i, (s, h, t) in enumerate(pairs, 1)]


INPUT = {"fileAccessChecks": "false", "pauseNodeIfAccessChecksFail": "false"}


def error_nodes(p, y):
    return [node(f"{p}_ERROR_HANDLER", "On Flow Error", "onFlowError", x=1200, y=y),
            node(f"{p}_HARD_FAIL", "Hard Fail", "failFlow", x=1200, y=y + 120)]


PRIORITY = {"adaptive_hevc_1_report": 10, "adaptive_hevc_2_encode": 11, "adaptive_hevc_3_verify": 12, "adaptive_hevc_4_notify": 13}


def flow(fid, name, plugins, pairs):
    return {"_id": fid, "name": name, "priority": PRIORITY[fid], "isUiLocked": False, "flowPlugins": plugins, "flowEdges": edges(pairs)}


GPU_WANTED = {"variable": "{{{args.userVariables.library.v8_encoder}}}", "condition": "==", "value": "gpu"}

f1 = flow("adaptive_hevc_1_report", "Adaptive HEVC - 1 Report", [
    node("F1_INPUT", "Input File", "inputFile", inputs=INPUT, y=0),
    node("F1_CHECK_HEVC", "Skip: Already HEVC?", "checkVideoCodec", inputs={"codec": "hevc"}, y=130),
    node("F1_SKIP_HEVC", "Skip: Already HEVC", "setOriginalFile", inputs={}, x=1100, y=130),
    node("F1_CHECK_AV1", "Skip: Already AV1?", "checkVideoCodec", inputs={"codec": "av1"}, y=260),
    node("F1_SKIP_AV1", "Skip: Already AV1", "setOriginalFile", inputs={}, x=1100, y=260),
    node("F1_PROFILE", "Source Profile (codec, quality/bpp, HDR/DV, interlace, conform needs)", "customFunction", inputs={"code": code["source_profile"]}, y=390),
    node("F1_SKIP_PROFILE", "Skip: Lean / DV / Too Short", "setOriginalFile", inputs={}, x=1100, y=390),
    node("F1_WANT_GPU", "Library v8_encoder = gpu?", "checkFlowVariable", inputs=GPU_WANTED, y=520),
    node("F1_CHECK_NVENC", "GPU: Node Has NVENC?", "checkNodeHardwareEncoder", inputs={"hardwareEncoder": "hevc_nvenc"}, x=480, y=650),
    node("F1_SET_GPU", "GPU Path: encoder = hevc_nvenc", "setFlowVariable", inputs={"variable": "encoder", "value": "hevc_nvenc"}, x=480, y=780),
    node("F1_SET_CPU", "CPU Path: encoder = libx265", "setFlowVariable", inputs={"variable": "encoder", "value": "libx265"}, x=1040, y=780),
    node("F1_REPORT", "Quality Report (sample encodes -> CRF/CQ, or skip)", "customFunction", inputs={"code": code["quality_report"]}, y=910),
    node("F1_GOTO_ENCODE", "→ Go To Flow 2: Encode", "goToFlow", "2.0.0", {"flowId": "adaptive_hevc_2_encode", "pluginId": "F2_INPUT"}, x=600, y=1040),
    node("F1_SKIP_REPORT", "Skip: Not Worth Encoding", "setOriginalFile", inputs={}, x=1000, y=1040),
] + error_nodes("F1", 0), [
    ("F1_INPUT", 1, "F1_CHECK_HEVC"),
    ("F1_CHECK_HEVC", 1, "F1_SKIP_HEVC"), ("F1_CHECK_HEVC", 2, "F1_CHECK_AV1"),
    ("F1_CHECK_AV1", 1, "F1_SKIP_AV1"), ("F1_CHECK_AV1", 2, "F1_PROFILE"),
    ("F1_PROFILE", 1, "F1_WANT_GPU"), ("F1_PROFILE", 2, "F1_SKIP_PROFILE"),
    ("F1_WANT_GPU", 1, "F1_CHECK_NVENC"), ("F1_WANT_GPU", 2, "F1_SET_CPU"),
    ("F1_CHECK_NVENC", 1, "F1_SET_GPU"), ("F1_CHECK_NVENC", 2, "F1_SET_CPU"),
    ("F1_SET_GPU", 1, "F1_REPORT"), ("F1_SET_CPU", 1, "F1_REPORT"),
    ("F1_REPORT", 1, "F1_GOTO_ENCODE"), ("F1_REPORT", 2, "F1_SKIP_REPORT"),
    ("F1_ERROR_HANDLER", 1, "F1_HARD_FAIL"),
])

f2 = flow("adaptive_hevc_2_encode", "Adaptive HEVC - 2 Encode", [
    node("F2_INPUT", "Input File", "inputFile", inputs=INPUT, y=0),
    node("F2_START", "Begin FFmpeg Command", "ffmpegCommandStart", inputs={}, y=150),
    node("F2_BUILD", "Build Encode (x265 CRF + conform streams + MKV)", "customFunction", inputs={"code": code["build_encode"]}, y=300),
    node("F2_EXECUTE", "Execute Encode (single pass)", "ffmpegCommandExecute", inputs={}, y=450),
    node("F2_GOTO_VERIFY", "→ Go To Flow 3: Verify", "goToFlow", "2.0.0", {"flowId": "adaptive_hevc_3_verify", "pluginId": "F3_INPUT"}, y=600),
] + error_nodes("F2", 0), [
    ("F2_INPUT", 1, "F2_START"), ("F2_START", 1, "F2_BUILD"), ("F2_BUILD", 1, "F2_EXECUTE"),
    ("F2_EXECUTE", 1, "F2_GOTO_VERIFY"), ("F2_ERROR_HANDLER", 1, "F2_HARD_FAIL"),
])

f3 = flow("adaptive_hevc_3_verify", "Adaptive HEVC - 3 Verify", [
    node("F3_INPUT", "Input File", "inputFile", inputs=INPUT, y=0),
    node("F3_VERIFY", "Verify (HEVC, duration, audio, size) -> ok / keep original / retry", "customFunction", inputs={"code": code["verify"]}, y=150),
    node("F3_GOTO_NOTIFY", "→ Go To Flow 4: Replace + Notify", "goToFlow", "2.0.0", {"flowId": "adaptive_hevc_4_notify", "pluginId": "F4_INPUT"}, x=600, y=320),
    node("F3_DELETE", "Keep Original: Delete Encode", "deleteFile", inputs={}, x=920, y=320),
    node("F3_RESTORE", "Keep Original: Restore", "setOriginalFile", inputs={}, x=920, y=470),
    node("F3_RETRY_DELETE", "Retry: Delete Encode", "deleteFile", inputs={}, x=1240, y=320),
    node("F3_RETRY_RESTORE", "Retry: Restore Original", "setOriginalFile", inputs={}, x=1240, y=470),
    node("F3_RETRY_GOTO", "Retry: → Re-Encode (Flow 2)", "goToFlow", "2.0.0", {"flowId": "adaptive_hevc_2_encode", "pluginId": "F2_INPUT"}, x=1240, y=620),
] + error_nodes("F3", 0), [
    ("F3_INPUT", 1, "F3_VERIFY"), ("F3_VERIFY", 1, "F3_GOTO_NOTIFY"), ("F3_VERIFY", 2, "F3_DELETE"), ("F3_VERIFY", 3, "F3_RETRY_DELETE"),
    ("F3_DELETE", 1, "F3_RESTORE"), ("F3_RETRY_DELETE", 1, "F3_RETRY_RESTORE"), ("F3_RETRY_RESTORE", 1, "F3_RETRY_GOTO"),
    ("F3_ERROR_HANDLER", 1, "F3_HARD_FAIL"),
])

# Flow 4: replace the original, notify Sonarr/Radarr, refresh Plex (kept as a template)
f4 = copy.deepcopy(notify_template)
f4["_id"], f4["name"], f4["priority"] = "adaptive_hevc_4_notify", "Adaptive HEVC - 4 Notify", PRIORITY["adaptive_hevc_4_notify"]

flows = [f1, f2, f3, f4]
for f in flows:
    ids = {p["id"] for p in f["flowPlugins"]}
    bad = [e for e in f["flowEdges"] if e["source"] not in ids or e["target"] not in ids]
    if bad:
        raise SystemExit(f'{f["_id"]}: edges point at missing nodes: {bad}')

os.makedirs(OUT, exist_ok=True)
try:
    import yaml

    class LiteralDumper(yaml.SafeDumper):
        pass

    def _str(dumper, data):   # multi-line strings (the embedded JavaScript) as readable literal blocks
        style = "|" if "\n" in data else None
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

    LiteralDumper.add_representer(str, _str)
except ImportError:
    yaml = None
    print("PyYAML not installed: writing JSON only (pip install pyyaml for the .yml exports)")

for n, f in enumerate(flows, 1):
    base = os.path.join(OUT, f'{n} - {re.sub(r"^[0-9]+ +", "", f["name"].split(" - ")[-1])}')   # e.g. "1 - Report"
    json.dump(f, open(f"{base}.json", "w"), indent=2, ensure_ascii=False)
    if yaml:
        yaml.dump(f, open(f"{base}.yml", "w"), Dumper=LiteralDumper, sort_keys=False, allow_unicode=True, width=120)
    print(f'{os.path.basename(base)}: {len(f["flowPlugins"])} nodes, {len(f["flowEdges"])} edges')
json.dump(flows, open(os.path.join(OUT, "all-flows.json"), "w"), indent=1, ensure_ascii=False)
