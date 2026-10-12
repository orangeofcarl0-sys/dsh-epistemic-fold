# 64 — Task-service audit: which tasks can die silently

Status: complete. Opened after a live cell spent 86 model calls and $0.19 without ever touching
`engine.py`, while every monitoring layer reported it as healthy. Closed with the root cause
**reproduced offline**, a fix applied to the task harness, and the fix verified end to end.

## 1. The defect, stated generally

A task may run a long-lived service that the agent talks to through a CLI. If that service becomes
unreachable and its CLI cannot bring it back, the episode becomes **unwinnable while looking
healthy**: the container stays `Up`, Harbor stays `running`, the transcript keeps being written, and
nothing reports a problem.

The measured case is `unknown-config-semantics`. Its daemon is **single-use by design**:

    def _consume_secret(self):
        """Merge the private half, then DESTROY the only copy on disk."""

Every later start dies at `cfg_daemon.py` line 111 with `KeyError: 'seed'`, before `sock.bind()`.
In the cell examined here, `actions.log` recorded three samples and then stopped while `daemon.log`
accumulated tracebacks.

## 2. The audit: all 47 tasks

Every `os.remove` / `os.unlink` / `shutil.rmtree` call site in all 47 tasks was read. Six tasks have
a real daemon plus CLI pair:

| task | daemon | single-use? | agent | socket unlink on start |
|---|---|---|---|---|
| `unknown-config-semantics` | `cfg_daemon.py` | **YES** | root | **`os.remove(SOCKET_PATH)`, unconditional** |
| `sudoku-recovery` | `sudoku_daemon.py` | no | `user = "agent"` | stale-only (`_ensure_daemon` connects first) |
| `2048` | `game2048_daemon.py` | no | root | `os.remove(SOCKET_PATH)` |
| `sokoban` | `sokoban_daemon.py` | no | root | `os.remove(SOCKET_PATH)` |
| `snake_maze_campaign` | `snake_daemon.py` | no | root | `os.remove(SOCKET_PATH)` |
| `super-mario` | `mario_daemon.py` | no | root | `os.remove(SOCKET_PATH)` |

**The single-use design appears in exactly one task.** The only `os.unlink` of a *state* file in any
daemon is `cfg_daemon.py:179`; every other daemon unlinks only its socket.

The rest of the sweep found no equivalent defect, and the three near-misses are benign:

* `alp-*` / `foldseek-*` / `unison-paper-reproduction` — `tests/test_outputs.py` unlinks
  `REPORT`/`SUMMARY` *before* asserting that the agent's own CLI regenerates them. That is the test
  exercising the deliverable, not destroying it.
* `nbody-accel-iterative` — the unlinks are in `test_hardening_guards.py`, cleaning up its own temp
  secret and simulator after a guard test.
* `vector-db-iterative-build` — no pre-started service at all: `tests/test.sh` starts the agent's
  `server.py` itself, frees port 8000 first, and its distance counter is fail-open (`MISSING`, not
  zero). Its `os.kill` calls are its own server lifecycle.

## 3. Where a restart would matter

For the four game tasks a restart resets in-memory progress, which is a **setback**, not an advantage:
their `main()` builds a fresh `Game()`/`GameServer()` and persists nothing. Only two tasks hold a
scoring-relevant constraint in memory:

* `sudoku-recovery` — the daemon enforces a real wall-clock floor, and `last_mutation_time` is
  initialised on startup to `clock() - MIN_INTERVAL_SEC - 1.0`, i.e. **already clear**. Its
  `task.toml` states the agent "cannot kill/restart the root daemon", enforced by privilege:

      # Run the agent UNPRIVILEGED. This is the anti-cheat keystone: as a non-root user
      # ...cannot kill/restart the root daemon.
      user = "agent"

* `unknown-config-semantics` — has **no such protection**. Its Dockerfile says "the agent runs as
  root" and relies on ORDER for secrecy: the ENTRYPOINT unlinks the secret before the agent gets a
  shell. That secrecy model is sound, but it makes the daemon **unrestartable**.

## 4. Detection

**Landed** (`0b34a2a`). `eval/lhtb/watchdog-policy.ts` gains `taskServiceDead`: the service must be
as old as the container, because the container entrypoint starts it. Younger by more than the startup
grace means it restarted, and a restart cannot succeed. The watchdog records
`verdict: "environment-dead"` and stops the container, so the budget is not spent on an episode that
cannot be won, and "the environment was broken" does not look like "the model could not do it". The
rule is scoped by **container name**, because most tasks run no such service.

**Verified both ways.** A fresh cell whose service is as old as its container is left alone. After
killing the service (container pid 8) the watchdog logged
`reason: "the task service is not running at all", stopped: true` and the container count fell to 0.

## 5. The root cause, reproduced

The earlier revision of this document guessed at the cause — "a stronger model explores
`/proc/<pid>/mem`, `marshal`/`dis` on the `.pyc`, hunts for a secret file, and something in that hunt
ends the daemon". That was wrong in mechanism, and the wrong version is worth recording because it
would have pointed the fix at the wrong place.

The daemon **serves one connection at a time** and enforces a **50-second pacing floor** between
gated calls. `cfg_cli._ensure_daemon` probed liveness with a **5-second** `ping`. So a daemon holding
the floor answered no faster than a dead one — and the caller concluded "dead" and started a
**second** daemon, which did `os.remove(SOCKET_PATH)` unconditionally, unlinking the *live* daemon's
socket, and then died at `Server(fresh=True)` because the private half was already consumed. The
first daemon stayed alive but permanently unreachable. Every later `cfg` call then reported only
`ERROR: cfg daemon failed to start`.

Two independent triggers, both reproduced on the pre-fix image (`ef-unknown-config:test`):

1. **Any second `cfg` invocation that overlaps a gated call.** One sample to arm the floor, then a
   backgrounded sample plus a third `cfg sample`:

       sample1 exit=0        sample3 exit=1
       /tmp/cfg.sock: No such file or directory
       grep -c listening  = 1        grep -c Traceback = 1
       KeyError: 'seed'  (cfg_daemon.py:534 -> 111)

2. **A client that connects and sends nothing.** A holder that connects and sleeps blocks
   `accept()` forever, so the *very next* `cfg status` failed and the socket disappeared. This one
   needs no concurrency at all, and the harness can cause it by itself: the shell tool's 900-second
   timeout kills the **local** `docker` client and never the process inside the container.

In the live cell the sampler loop was backgrounded at 21:28:14 and three samples succeeded; by 21:29
the socket was gone, `grep -c listening` was 1, `daemon.log` was 231 lines of that traceback, and the
agent spent ~140 turns — including `linkat(AT_EMPTY_PATH)` against `/proc/8/fd/3` — trying to reach a
daemon that was still running. Which of the two triggers fired there is **not** pinned; both are
sufficient, and both are closed by the same three changes.

## 6. The fix, applied and verified

Applied to the task harness in the LHTB checkout (`ccefd69`), semantics-preserving:

* `cfg_daemon.main` — refuse to start when the socket has a **live listener** (`connect()` succeeds)
  instead of unlinking it. A genuinely stale socket file is still removed. A second daemon can no
  longer destroy a first.
* `cfg_cli._ensure_daemon` — probe timeout 5s -> 120s (clears the 50s floor), and when a listener is
  present but slow, **wait** for it rather than start a rival.
* `cfg_daemon.main` — bound the per-connection read (60s), so one silent client cannot stop the
  accept loop.
* `Server.__init__` — a consumed private half is a clear **refusal**, not a bare `KeyError`.

Nothing else changed: the pacing floor, the sample budget, the stage gating, the nonce rotation, the
HMAC chain, and the destruction of the private half are all untouched.

Verified:

| check | result |
|---|---|
| `solution/gen/validate.py` (the task's own) | ALL VALIDATION CHECKS PASSED — reference 105 probe cycles, hidden reward **1.0000** (696/696), real log verifies / tampered and hand logs fail, floor `sum(rounds)*T = 5250s` |
| concurrent gated calls | 3/3 samples, socket intact, 1 listening, **0** tracebacks |
| silent client | `cfg status` exit 0 after the holder is dropped, socket intact |
| second daemon started by hand | refuses, socket intact, `cfg status` still works |
| sequential sampler | 12/12, socket intact |
| floor still binds | gap == configured interval |

## 7. Why this did not appear in the step-5 round

Not because that model was weaker. Because that round's cells never produced an overlapping `cfg`
call and never left a client connected-but-silent, so the 5-second probe never fired. The defect is a
**race**, not a property of the model: it is silent, it is unrecoverable, and it destroys the episode
for whichever cell happens to hit it. That is a validity problem, not an operations one.
