# 113 — Stack sample: the bridge is NOT the blocker; it is waiting for the agent

Status: **localized to the agent side.** 2026-10-16. Parent `52e6540`.

## A. How the sample was taken on a LIVE process

`process._debugProcess(<pid>)` enables the inspector on an already-running Node process. It worked
here -- no restart, no relaunch, and the stalled episode kept its state:

```
node -e "process._debugProcess(74316)"   -> inspector listening on 127.0.0.1:9229
GET http://127.0.0.1:9229/json            -> bridge-host.ts
```

Then one CDP `Runtime.evaluate` asked the process what it is waiting on.

## B. The answer

```
bridge uptimeSec = 3337   (55.6 minutes)
ACTIVE HANDLES:
  {"t":"Socket","fd":0}      <- stdin
  {"t":"Socket","fd":1}      <- stdout
ACTIVE REQUESTS: []
```

**Two pipes and nothing else. No network socket. No timer. No in-flight request.**

**The bridge is blocked reading its stdin.** It has answered everything it was asked and is waiting for
the agent to send the next op. The stall is therefore **not** in the bridge, **not** in the provider, and
**not** in the network -- which the earlier `TCP connections 0` reading suggested but could not prove,
since a closed connection and a connection never opened look identical from outside.

## C. And it is not a container command either

```
docker.exe processes on the host      0        <- no hanging `docker exec`
container state                       running (pid 458)
docker exec <container> echo alive    "alive"  <- exec works normally
process tree                          harbor 67856 -> python 64520 -> bridge 74316
```

The agent's own tool execution spawns a `docker exec`. There is none. **So the agent is not blocked in
a shell command** -- it is blocked between receiving the bridge's reply and sending the next step.

## D. What is established, and what is not

```
bridge blocked on stdin, no network, no timer   PROVEN by the live sample
agent not in a container command                PROVEN (no docker.exe, no children)
block is in the agent, between reply and step   INFERRED from the two above
WHICH call in the agent                          NOT ESTABLISHED
```

**The last step is the one that needs a Python stack**, and `py-spy` is not present in the harbor venv
and did not install into it. That is where this stopped.

## E. Why this matters for the two-phenomenon picture

`docs/112` separated the 403 loops (fixed by the tool gate) from an intermittent stall after some
number of successful calls. **This sample puts the second phenomenon on the agent side of the pipe, not
the bridge's** -- which is a different place to look from every previous guess in this thread, all of
which looked at the bridge, the route or the provider.
