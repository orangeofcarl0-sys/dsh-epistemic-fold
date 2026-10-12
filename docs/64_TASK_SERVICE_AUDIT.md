# 64 — Task-service audit: which tasks can die silently

Status: complete. Written after a live cell spent 86 model calls and $0.19 without ever touching
`engine.py`, while every monitoring layer reported it as healthy.

## 1. The defect, stated generally

A task may run a long-lived service that the agent talks to through a CLI. If that service dies, and
its CLI cannot bring it back, the episode becomes **unwinnable while looking healthy**: the container
stays `Up`, Harbor stays `running`, the transcript keeps being written, and nothing reports a problem.

The measured case is `unknown-config-semantics`. Its daemon is **single-use by design**:

    def _consume_secret(self):
        """Merge the private half, then DESTROY the only copy on disk."""

Every later start dies at `cfg_daemon.py` line 111 with `KeyError: 'seed'`, before `sock.bind()`. On
the live cell, `actions.log` recorded three samples and then stopped while `daemon.log` accumulated
**24** such crashes.

## 2. The audit: all 47 tasks

Twenty-one harness files match `*_daemon.py` / `*_cli.py` / `*_server.py`. Six tasks have a real
daemon plus CLI pair:

| task | daemon | single-use? | agent | can the agent kill it? |
|---|---|---|---|---|
| `unknown-config-semantics` | `cfg_daemon.py` | **YES** | **root** | **YES** |
| `sudoku-recovery` | `sudoku_daemon.py` | no | `user = "agent"` | no |
| `2048` | `game2048_daemon.py` | no | root | yes |
| `sokoban` | `sokoban_daemon.py` | no | root | yes |
| `snake_maze_campaign` | `snake_daemon.py` | no | root | yes |
| `super-mario` | `mario_daemon.py` | no | root | yes |

**The single-use design appears in exactly one task.** Every other daemon removes a stale socket on
start (`os.remove(SOCKET_PATH)`) and re-reads persistent state, so a restart succeeds.

## 3. The two tasks where a restart would matter

For the four game tasks a restart resets in-memory progress, which is a **setback**, not an advantage.
Only two tasks hold a scoring-relevant constraint in memory:

* `sudoku-recovery` — the daemon enforces a real wall-clock floor, and `last_mutation_time` is
  initialised on startup to `clock() - MIN_INTERVAL_SEC - 1.0`, i.e. **already clear**. Its
  `task.toml` states the floor alone forces >= 4380s of wall-clock, and that the agent "cannot
  kill/restart the daemon". That claim is enforced by privilege:

      # Run the agent UNPRIVILEGED. This is the anti-cheat keystone: as a non-root user
      # ...cannot kill/restart the root daemon.
      user = "agent"

* `unknown-config-semantics` — has **no such protection**. Its Dockerfile says "the agent runs as
  root" and relies on ORDER for secrecy: the ENTRYPOINT unlinks the secret before the agent gets a
  shell. That secrecy model is sound, but it makes the daemon **unrestartable**, and a root agent
  can end it.

So the defect class is real, and the protection that closes it already exists in this repository —
it is simply absent from the one task that needs it most.

## 4. What was done

**Detected** (`0b34a2a`). `eval/lhtb/watchdog-policy.ts` gains `taskServiceDead`: the service must be
as old as the container, because the container entrypoint starts it. Younger by more than the
startup grace means it restarted, and a restart cannot succeed. The watchdog records
`verdict: "environment-dead"` and stops the container, so the budget is not spent on an episode that
cannot be won, and "the environment was broken" does not look like "the model could not do it".

The rule is scoped by **container name**. Most tasks run no such service, and an unscoped rule would
declare every healthy cell of every other task dead.

**Verified both ways.** A fresh cell whose service is as old as its container is left alone. After
killing the service (container pid 8) the watchdog logged
`reason: "the task service is not running at all", stopped: true` and the container count fell to 0.

## 5. What is NOT done, and why

**Prevention.** `unknown-config-semantics` could adopt sudoku's keystone — run the agent
unprivileged. `/opt/cfg` is world-writable and `engine.py` is mode 777, so the agent could still do
the task, and it could no longer end the daemon.

That is a **task change**, and it would move the task's conditions away from the existing corpus, so
it is recorded here rather than applied. Detection protects the budget and the record now; prevention
would protect the measurement itself, and that trade is a decision for the task's owner.

## 6. Why this never appeared in the step-5 round

The daemon is started **once** there, because that round's model went straight at the task. A stronger
model explores — reading `/proc/<pid>/mem` and `/proc/<pid>/environ`, decompiling
`__pycache__/cfg_daemon.cpython-*.pyc` with `marshal`/`dis`, hunting for a secret file — and
something in that hunt ends the daemon.

**The defect is therefore selective against stronger models.** That is a validity problem, not an
operations one: it penalises exactly the models the benchmark exists to discriminate between, and it
does so silently.
