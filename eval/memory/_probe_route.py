import json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bridge"))
from ef_bridge_client import EpistemicFoldBridge
b = EpistemicFoldBridge(arm="quality", bundle_root=str(HERE / "_bundles"), domain="probe", task_id="probe")
b.init("Answer briefly.", [])
b.append({"role": "user", "content": "Reply with the single word ok."})
r = b.step()
print("keys:", sorted(r.keys()))
print("error:", json.dumps(r.get("error"))[:600])
print("content:", json.dumps(r.get("content"))[:300])
t = b.last_telemetry
print("providerFailures:", t.get("providerFailures"))
for k in sorted(t):
    if "rror" in k or "rovider" in k:
        print(f"  {k}: {json.dumps(t[k])[:400]}")
b.close()
