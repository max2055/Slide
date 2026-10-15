#!/bin/bash
set -euo pipefail
# No systemd PID 1, privileged mode, host mounts or invented command output.
# The services section is expected to remain partial in this container.
/usr/lib/systemd/systemd-journald &
/usr/sbin/rsyslogd -n -i /run/max175-rsyslog.pid -f /etc/max175-rsyslog.conf &
python3 -m http.server 8080 --bind 0.0.0.0 --directory /srv/max175 >/run/max175-http.log 2>&1 &
exec /usr/sbin/sshd -D -e -o PasswordAuthentication=yes -o PermitRootLogin=no
