#!/bin/sh
# Stands in for docker when its daemon is down: every command fails the way
# the real CLI does. Each call is logged to $FAKE_CALLS.
echo "$@" >> "$FAKE_CALLS"
echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
exit 1
