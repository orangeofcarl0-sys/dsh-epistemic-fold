"""Ask the configured route one question and print what it says.

This exists because a route can be wrong in a way that looks like health: a missing
\`x-opencode-session\` header answers a fast HTTP 400 MissingSessionID, and a proxy that is not
being used answers nothing at all while \`curl\` reports success. Both were mistaken for
provider turbulence in this session, and both cost time that a one-line probe would have saved.

Run it through the launcher so it inherits the same environment the driver gets:

    bash eval/memory/run-memory.sh --check-route

It reports the reply's \`error\` field verbatim, because the difference between "429 rate limited"
and "400 MissingSessionID" is the difference between waiting and fixing.
"""
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


def main() -> None:
    from pathlib import Path
    HERE = Path(__file__).resolve().parent
    sys.path.insert(0, str(HERE.parent / "bridge"))
    from ef_bridge_client import EpistemicFoldBridge
    b = EpistemicFoldBridge(arm="quality", bundle_root=str(HERE / "_bundles"),
                            domain="probe", task_id="probe")
    b.init("Answer briefly.", [])
    b.append({"role": "user", "content": "Reply with the single word ok."})
    r = b.step()
    err = r.get("error")
    print("error:", json.dumps(err)[:400] if err else "(none)")
    print("content:", json.dumps(r.get("content"))[:200])
    b.close()


if __name__ == "__main__":
    main()
