#!/usr/bin/env python3
"""Write apps/web/public/memories/status.json for the viewer's status page (/status/index.html): pod progress over
ssh, local scenes, a progress log.   python pipeline/tools/status_update.py [--loop N] | --log "message" """
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MEM = REPO / "apps/web/public/memories"
OUT = MEM / "status.json"
LOGF = MEM / "progress_log.json"
POD = ["ssh", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
       "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=15", "-i", str(Path.home() / ".ssh/memreplay_runpod"),
       "-p", "31390", "root@38.80.152.148"]
CLIPS = {"img8013": ("Hotel room", 42), "img8014": ("Hotel room corner", 11), "img8015": ("Hotel corridor", 73),
         "img8016": ("Hotel lobby", 34), "img8017": ("Night walk downtown", 142),
         "v59": ("Stage: speaker at the podium", 18), "v71": ("Stage and the hall", 39), "v83": ("Hackathon hall walk", 45),
         "v106": ("Hackathon hall, long walk", 60), "o3329": ("Palace of Fine Arts: short", 7),
         "o3328": ("Palace of Fine Arts: rotunda and people", 43), "o3330": ("Palace of Fine Arts: colonnade walk", 60),
         "o3331": ("Palace of Fine Arts: colonnade walk 2", 60), "o3332": ("Palace of Fine Arts: garden and people", 50)}
REMOTE = r'''date +%H:%M:%S; echo ===; tail -40 /workspace/logs/static_run.log 2>/dev/null; echo ===; tail -30 /workspace/logs/post_run.log 2>/dev/null; echo ===;
for c in v59 v71 v83 v106 o3328 o3329 o3330 o3331 o3332; do f=/workspace/work/$c/logs/background_static.log; if [ -f $f ]; then echo "$c $(tr '\r' '\n' < $f | grep -oE '[0-9]+/20100' | tail -1)"; fi;
 g=/workspace/work/$c/logs/vipe.log; if [ -f $g ] && [ ! -f /workspace/work/$c/vipe/pose/clip.npz ]; then echo "$c vipe $(tr '\r' '\n' < $g | grep -aoE '[A-Za-z ]+\([0-9]/[0-9]\): +[0-9]+%' | tail -1)"; fi; done; echo ===; tail -6 /workspace/logs/4dgs.log 2>/dev/null'''


def now():
    return datetime.now(timezone.utc).isoformat()


def log(msg):
    entries = json.loads(LOGF.read_text()) if LOGF.exists() else []
    entries.append({"t": now(), "msg": msg})
    LOGF.write_text(json.dumps(entries, indent=1))


def pod_status():
    try:
        out = subprocess.run(POD + [REMOTE], capture_output=True, text=True, timeout=45).stdout
    except Exception as e:
        return {"state": f"unreachable ({e})", "lines": []}, {}
    parts = out.split("===")
    if len(parts) < 5:
        return {"state": "stopped or unreachable", "lines": []}, {}
    static_log, post_log, prog, fourd = parts[1], parts[2], parts[3], parts[4]
    rooms = {}
    for ln in static_log.splitlines():
        m = re.search(r"(\S+) static ok \((\d+) s\)", ln)
        if m:
            rooms[m.group(1)] = {"room_state": "done", "room_progress": 1.0, "room_note": f"{int(m.group(2)) // 60} min"}
        m = re.search(r"(\S+) static splat FAILED", ln)
        if m:
            rooms[m.group(1)] = {"room_state": "failed", "room_progress": 0, "room_note": "see logs"}
        m = re.search(r"(\S+) (normalize|nouns|vipe|world|l0|objects) ok", ln)
        if m and m.group(1) not in rooms:
            rooms[m.group(1)] = {"room_state": f"{m.group(2)} done", "room_progress": 0.1, "room_note": ""}
        m = re.search(r"(\S+) (normalize|nouns|vipe|world|l0|objects) FAILED", ln)
        if m:
            rooms[m.group(1)] = {"room_state": f"{m.group(2)} FAILED", "room_progress": 0, "room_note": "see logs"}
    for ln in prog.splitlines():
        m = re.match(r"(\S+) (\d+)/20100", ln.strip())
        if m and rooms.get(m.group(1), {}).get("room_state") != "done":
            rooms[m.group(1)] = {"room_state": "training", "room_progress": int(m.group(2)) / 20100, "room_note": f"step {m.group(2)} of 20100"}
        m = re.match(r"(\S+) vipe (.*)", ln.strip())
        if m and m.group(2):
            rooms[m.group(1)] = {"room_state": "ViPE", "room_progress": 0.05, "room_note": m.group(2)[:60]}
    layers = {}
    for ln in post_log.splitlines():
        m = re.match(r"(\S+) \[layers\] (.*)", ln)
        if m:
            layers[m.group(1)] = m.group(2)[:160]
    lines = [ln for ln in (static_log + post_log).splitlines() if ln.strip()][-8:] + [ln for ln in fourd.splitlines() if ln.strip()][-4:]
    return {"name": "memory-replay-gpu-a (+ gpu-b for 4DGS)", "gpu": "2x H100 SXM + 2x H200", "cost": "$18.6/h", "state": "running", "lines": lines}, {"rooms": rooms, "layers": layers}


def scenes(info):
    out = []
    for cid, (title, secs) in CLIPS.items():
        d = MEM / cid
        s = {"id": cid, "title": title, "seconds": secs, "dynamic": (d / "memory.json").exists(), "static": (d / "memory.static.json").exists()}
        s.update(info.get("rooms", {}).get(cid, {"room_state": "queued" if not s["dynamic"] else "done", "room_progress": 1.0 if s["dynamic"] else 0}))
        s["layers"] = info.get("layers", {}).get(cid)
        if (d / "compare.jpg").exists():
            s["grid"] = f"/memories/{cid}/compare.jpg"
        out.append(s)
    return out


def write(note=""):
    pod, info = pod_status()
    MEM.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"updated": now(), "note": note, "pod": pod, "scenes": scenes(info),
                               "log": json.loads(LOGF.read_text()) if LOGF.exists() else []}, indent=1))


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--log":
        log(sys.argv[2]); write(); print("logged")
    elif len(sys.argv) > 2 and sys.argv[1] == "--loop":
        while True:
            try:
                write()
            except Exception as e:
                print("status update failed:", e)
            time.sleep(int(sys.argv[2]))
    else:
        write(); print(OUT)
