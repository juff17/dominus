# shellcheck shell=bash
# The agent hub's logger for bash (docs/logging.md): one line per event,
#   <UTC time> <LEVEL> <component>: <message> <json fields>
# appended to $XDG_STATE_HOME/agent-hub/logs/<component>.log, the same lines
# the Node and Python loggers write. Most calls run no other program, so it's
# cheap on hot paths; it never writes to stdout or stderr.
#
#   source "$GHOSTTY_CONF/bin/lib/log.sh"
#   ah_log warn tray "poll failed" exit "$status" cmd "$cmd"
#
# Fields are key value pairs. A value that looks like a number, true, false
# or null is written bare; anything else is a JSON string.

AH_LOG_MAX_BYTES=$((1024 * 1024))

ah_log_dir() {
  printf '%s' "${AGENT_HUB_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub/logs}"
}

ah_log_level_ok() {
  local -A rank=([debug]=10 [info]=20 [warn]=30 [error]=40)
  local bar=''
  # An empty subscript is an error bash prints, so an unset level is skipped.
  [[ -n ${AGENT_HUB_LOG_LEVEL:-} ]] && bar=${rank[$AGENT_HUB_LOG_LEVEL]:-}
  [[ -n $bar ]] || { [[ ${AGENT_HUB_DEBUG:-} == 1 ]] && bar=10 || bar=20; }
  ((${rank[$1]:-0} >= bar))
}

# ah_json_string TEXT: TEXT as a quoted JSON string, into $REPLY.
ah_json_string() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  s=${s//[$'\x01'-$'\x1f']/}
  REPLY="\"$s\""
}

# ah_log_line LEVEL COMPONENT MESSAGE [KEY VALUE]...: the line, into $REPLY.
ah_log_line() {
  local level=$1 component=$2 message=$3
  shift 3
  local t=$EPOCHREALTIME stamp frac json='' key value
  TZ=UTC printf -v stamp '%(%Y-%m-%dT%H:%M:%S)T' "${t%.*}"
  frac=${t#*.}
  while (($# >= 2)); do
    key=$1 value=$2
    shift 2
    if [[ $value =~ ^-?(0|[1-9][0-9]*)(\.[0-9]+)?$ || $value == true || $value == false || $value == null ]]; then
      :
    else
      ah_json_string "$value"
      value=$REPLY
    fi
    ah_json_string "$key"
    json+="${json:+,}$REPLY:$value"
  done
  REPLY="$stamp.${frac:0:3}Z ${level^^} $component: $message {$json}"
}

# The Claude session a line was written under, so it leads back to the
# transcript, unless the call names one itself.
ah_log() {
  ah_log_level_ok "$1" || return 0
  local dir=${AGENT_HUB_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-hub/logs}
  local file=$dir/$2.log
  local -a args=("$@")
  if [[ -n ${CLAUDE_CODE_SESSION_ID:-} ]]; then
    local i named=''
    for ((i = 3; i < ${#args[@]}; i += 2)); do
      if [[ ${args[i]} == claude_session ]]; then named=1; fi
    done
    if [[ -z $named ]]; then args+=(claude_session "$CLAUDE_CODE_SESSION_ID"); fi
  fi
  ah_log_line "${args[@]}"
  {
    [[ -d $dir ]] || mkdir -p "$dir"
    # Bash can't read a file's size itself, so stat runs on about one write in
    # 64 rather than every one.
    if ((RANDOM % 64 == 0)) && [[ -f $file ]]; then
      local size
      size=$(stat -c %s "$file" 2>/dev/null) || size=0
      ((size > AH_LOG_MAX_BYTES)) && mv -f "$file" "$file.1"
    fi
    printf '%s\n' "$REPLY" >>"$file"
  } 2>/dev/null || true
}
