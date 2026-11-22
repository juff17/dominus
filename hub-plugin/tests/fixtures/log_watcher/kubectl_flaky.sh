#!/bin/sh
# Stands in for kubectl: `get pods` prints $FAKE_PODS, while `logs` is
# refused the first two times and then stays up for a few seconds. Each call
# is logged to $FAKE_CALLS.
echo "$@" >> "$FAKE_CALLS"
case " $* " in
  *" get pods "*) cat "$FAKE_PODS" ;;
  *" logs "*)
    if [ "$(grep -c ' logs ' "$FAKE_CALLS")" -le 2 ]; then
      echo "error: You must be logged in to the server (Unauthorized)" >&2
      exit 1
    fi
    echo "[pod/api-7d9f-x2k4p/app] INFO serving"
    exec sleep 3 ;;
  *) exit 1 ;;
esac
