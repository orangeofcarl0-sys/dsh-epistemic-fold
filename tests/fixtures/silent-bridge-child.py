import sys, time
# A child that stays ALIVE, keeps stdout OPEN, and never answers.
# This is the shape `_send`'s read timeout cannot tell apart from a slow host.
for line in sys.stdin:
    pass
time.sleep(600)
