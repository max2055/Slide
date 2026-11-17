# Stub-harness observation only. No signal trap or service process changes.
# FD 8 is a pre-opened task-exclusive regular file, never a pipe.
boundary_sequence=0
boundary_caller=""
boundary_namespace="$(readlink /proc/$$/ns/pid 2>/dev/null || true)"
boundary_supported=0
if [[ -n "${EPOCHREALTIME:-}" && -n "$boundary_namespace" && -r /proc/$$/stat ]]; then boundary_supported=1; fi
boundary_mark() {
  [[ "$boundary_supported" == 1 ]] || return 0
  local begin="$EPOCHREALTIME" event="$1" target="$2" status="${3:-na}"
  local recorded_signal="${signal:-none}"
  case "$event" in watchdog_kill_*) recorded_signal=TERM ;; esac
  local caller="${BASHPID:-$$}" raw="" cstart=gone cppid=gone tstart=gone tppid=gone ns=gone
  local -a values=()
  if [[ "$boundary_caller" != "$caller" ]]; then boundary_sequence=0; boundary_caller="$caller"; fi
  boundary_sequence=$((boundary_sequence + 1))
  if IFS= read -r raw < "/proc/$caller/stat"; then
    raw="${raw##*) }"; read -r -a values <<< "$raw"
    cppid="${values[1]}"; cstart="${values[19]}"
  fi
  if [[ -r "/proc/$target/stat" ]]; then
    IFS= read -r raw < "/proc/$target/stat" || raw=""
    raw="${raw##*) }"; read -r -a values <<< "$raw"
    tppid="${values[1]:-gone}"; tstart="${values[19]:-gone}"
    if [[ "/proc/$target/ns/pid" -ef /proc/$$/ns/pid ]]; then ns="$boundary_namespace"; fi
  fi
  if [[ ! "/proc/$caller/ns/pid" -ef /proc/$$/ns/pid ]]; then cstart=invalid; fi
  if ! printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
    "$begin" "$EPOCHREALTIME" "$caller" "$cstart" "$cppid" "$boundary_namespace" \
    "$target" "$tstart" "$tppid" "$ns" "${name:-harness}" "$event" "$status" "$boundary_sequence" "$recorded_signal" >&8; then
    observation_failed=1
    printf 'write_failed\n' >> "$work/observations/boundary-errors"
  fi
}
