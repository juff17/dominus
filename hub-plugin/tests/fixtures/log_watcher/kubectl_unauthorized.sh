#!/bin/sh
# Stands in for kubectl: `get pods` prints $FAKE_PODS (and fails when it
# can't), while `logs` is refused at once, as with an expired login. Each
# call is logged to $FAKE_CALLS.
echo "$@" >> "$FAKE_CALLS"
case " $* " in
  *" get pods "*) cat "$FAKE_PODS" 2>/dev/null || { echo "error: the server doesn't have a resource type \"pods\"" >&2; exit 1; } ;;
  *" logs "*) echo "error: You must be logged in to the server (Unauthorized)" >&2; exit 1 ;;
  *) exit 1 ;;
esac
