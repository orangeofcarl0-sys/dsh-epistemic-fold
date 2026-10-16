# 127 — Watchdog restart: the unit is the trial, not the daemon

Status: implemented. 2026-10-17. Parent `fe95e9e`.

## A. The watchdog did not restart anything, by design

`eval/lhtb/watchdog.ts:22`:

> It does NOT nudge the model, retry a step, **restart a cell**, or edit a transcript.

That was a deliberate boundary, and it is why a cell that died for environmental reasons was simply
stopped and recorded. The operator asked for the watchdog to handle bad calls and restart, so this
adds the missing path -- but the FIRST question was what may be restarted, and the answer is not the
obvious one.

## B. The daemon cannot be restarted, and the task says why

The obvious repair -- restart `cfg_daemon.py` inside the live container -- **cannot work**. Already
recorded at `watchdog.ts:267-271`:

> The staged-config task's daemon **consumes and DESTROYS its own secret on first start**, so a
> restart dies before it can listen and the episode becomes unwinnable.

**So `environment-dead` is genuinely terminal for the PROCESS.** What is recoverable is the EPISODE:
a fresh container gets a fresh daemon with a fresh secret. **The restart unit is the trial.**

## C. What was implemented

`restartCell(jobDir, cellLabel)`:

* **reads the job's OWN `config.json`** and relaunches from it, so the replacement re-runs the same
  task, model and environment that the original recorded -- **not anything re-derived here**, which
  could silently differ from what actually ran;
* **is called AFTER `docker stop`**, never before: the replacement must not race the container it
  replaces, since both mount the same task and the old one may still hold the daemon's port. Stopping
  first makes it a repair rather than a second copy;
* **is gated on `EF_WATCH_RESTART=1`** and otherwise records `restart-required` without acting -- a
  watchdog that silently spawns trials is worse than one that does not;
* records `restart-launched` / `restart-launch-failed` / `restart-config-unreadable` so a restart that
  did not happen cannot read like one that did.

`WatchedCell` gained `jobDir` for this; `basename` added to the path import.

## D. Verified

```
npx tsc --noEmit        no watchdog errors
startup guard           still exits 2 in 0.2s with no EF_WATCH_JOBS
```

**Not verified: an actual restart.** No `environment-dead` cell has occurred since this was added, so
the path is compiled and gated but has never fired. **That is stated rather than implied.**
