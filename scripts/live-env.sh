# Shared live-route environment for the route launchers.
#
# ## Why this file
#
# The credential read -- one value out of the refs block -- was byte-identical in
# four launchers (scripts/run-tau2.sh, scripts/run-live-parallel.sh,
# scripts/run-lhtb.sh, eval/memory/run-memory.sh), and the three EF_LIVE_* route
# exports were the same three lines with per-lane defaults. One implementation,
# so a fix to the read lands once instead of four times. Same reason
# scripts/proxy-env.sh exists.
#
# ## What stays with the caller
#
#   - the credential-store LOCATION. CREDENTIALS="${DSH_CREDENTIALS:-$HOME/...}"
#     and its "set DSH_CREDENTIALS" error stay in each launcher: release-hygiene
#     asserts the portable default is THERE, not behind an indirection, and that
#     assertion is what keeps an absolute path out of a published file.
#   - the ROUTE. Each lane names its own base URL and model; only the SHAPE of the
#     three exports is shared, so the defaults are arguments.
#   - the PROXY. The four callers differ in the EF_USE_PROXY default (0 on the
#     tau2 lane, 1 on LHTB -- docs/50 and docs/52 record that whether a host needs
#     a proxy is a property of the host), in whether the port is fixed or
#     discovered, and in whether HTTP_PROXY is set. That is policy, and folding it
#     together would change what a caller exports.
#
# Sourced, never executed.

# ef_read_key <python-interpreter> <credentials-file>
#   Reads ONE value out of the refs block. It is never echoed, never written to a
#   file and never passed as an argument; the callers deliberately do not use
#   set -x.
ef_read_key() {
  "$1" - "$2" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'^\s+OPENCODE_GO_API_KEY:\s*(\S+)\s*$', text, re.M)
sys.stdout.write(m.group(1) if m else '')
PY
}

# ef_export_route <key> <base-url-default> <model-default>
#   The three EF_LIVE_* variables every route launcher exports, in the order the
#   callers used to set them.
ef_export_route() {
  export EF_LIVE_BASE_URL="${EF_LIVE_BASE_URL:-$2}"
  export EF_LIVE_API_KEY="$1"
  export EF_LIVE_MODEL="${EF_LIVE_MODEL:-$3}"
}
