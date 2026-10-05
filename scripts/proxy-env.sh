# Scrub NO_PROXY before any Python or Node process starts.
#
# ## The defect, and why this file exists
#
# This machine's process environment carries a NO_PROXY that ends in a bracketed
# IPv6 literal:
#
#     ...,172.31.*,<local>,::1,[::1]
#
# httpx parses NO_PROXY as a comma-separated list of HOST:PORT entries. The
# bracketed literal is read as a host whose port is "1]", and every single
# request fails before it is sent:
#
#     httpx.InvalidURL: Invalid port: ':1]'
#
# It is not a network fault and not a credential fault, so it reads like neither.
# It has now broken four unrelated things on this machine: the tau2 sweep
# (LiteLLM's cost-map fetch), Harbor's embedded LiteLLM, the HuggingFace
# snapshot download, and a bare-urllib probe of the judge endpoint.
#
# ## Why scrubbing it in the calling shell is NOT enough
#
# The registered [User] value is clean - it ends at <local>. The bracket is
# appended at process-launch time by something above this repository, so a
# variable exported here would be re-appended by the next shell. The only point
# that holds is the one immediately before the interpreter that will read it.
#
# ## Why this is a sourced file rather than a copy in each runner
#
# Four runs needed this. Four copies of a proxy string is four places for it to
# drift, and a stale copy fails in a way that looks like a benchmark failure.
# tests/lhtb-parallelism.spec.ts and tests/tau2-bridge-contract.spec.ts both read
# this file, so removing the scrub breaks a test instead of a run.

# Both spellings are dropped. Windows environment blocks are case-insensitive yet
# can carry both, and which one wins is not predictable.
unset NO_PROXY
unset no_proxy

# Bracket-free. ::1 stays as a bare entry, which httpx parses as a host with no
# port; the bracket is what makes it a port.
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"
