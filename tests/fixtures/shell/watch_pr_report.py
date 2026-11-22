"""Prints the event lines pr-babysit's watch_pr.py would emit for one poll:
its report() on the snapshot in argv[2] (JSON), with a fresh state and
argv[3] as the user's own login. argv[1] is the scripts folder."""
import json
import sys

sys.path.insert(0, sys.argv[1])
import watch_pr

snap = json.load(open(sys.argv[2]))
state = {"events": set(), "comments": set()}
watch_pr.report(snap, state, sys.argv[3], 30)
