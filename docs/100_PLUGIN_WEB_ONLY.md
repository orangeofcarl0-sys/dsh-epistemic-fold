# 100 — The plugin activates ONLY in the web profile; a live instance is running on 3099

Status: **PLUGIN IS WEB-PROFILE-ONLY. MODEL CALL STILL UNTESTED. CONTEXT LENGTH NOT MEASURED.**
2026-10-16. Parent `f7a9e49`.

## A. The test the brief asked for, and its first hard result

`dsh headless` is the natural way to send one prompt and read the answer, so the plugin was installed
into the `headless` profile and driven with a one-shot patch that selects the free model. It failed
for a reason that is itself the finding:

```
opencode-free (dsh-opencode-free): pending (waiting for service: webServer)
dsh: NO_ADAPTER: no adapter registered for provider "opencode-zen-free"
```

**The plugin waits on the `webServer` service.** `headless` does not provide it, so the plugin never
activates and the provider is never registered. This is not a credential or admission problem -- the
request is never built. **`dsh-opencode-free` is a web-profile plugin.**

## B. A live instance, started and verified

The `web` profile boots the plugin cleanly (no activation warning):

```
dsh --profile web --port 3099
-> http://127.0.0.1:3099/?token=9kJTuts_uo30HvEtjvMrQDHV9YvkhxOqpl1mAPOe57w
```

**This is the one-click decisive test, and it is ready to run**: open that URL, choose
**OpenCode Zen Free -> `deepseek-v4.1-flash-free`**, and send any message.

* if it answers, the plugin works and the context ladder can be run against this path;
* if it answers 403, the free tier is closed regardless of client, and the question is settled.

## C. The GUI on 3080 does NOT have the plugin

That process started before this round's upgrade, so it is running the OLD `0.2.1-alpha.2` with no
`dsh-opencode-free` loaded. **A restart is what picks up alpha.3 and the plugin**; port 3099 exists
so that restart is not needed to test.

## D. Still not established

```
plugin activates in the web profile             YES (clean boot, no warning)
free model answers through the plugin           NOT TESTED -- no prompt sent yet
free model reachable from the LHTB lane        NO (plugin wraps DSH's own HTTP layer)
real context length                            NOT MEASURED
```

I did not send a prompt through the 3099 instance: driving the web API needs its request shape, and
that is where this round's budget ended. **The server is left running so the test costs one click
rather than another round.**
