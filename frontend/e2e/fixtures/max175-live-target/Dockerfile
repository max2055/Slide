FROM quay.io/centos/centos:stream9@sha256:4fdfb367402535024cd7703a67e4549ca3b0a0ee05081e06d89e24dce3a3827a
RUN dnf -y install openssh-server net-snmp procps-ng iproute python3 util-linux systemd rsyslog \
    && dnf clean all \
    && useradd -m -G systemd-journal fixture \
    && ssh-keygen -A \
    && mkdir -p /run/sshd /var/log/journal /srv/max175 \
    && chgrp systemd-journal /var/log/journal && chmod 2755 /var/log/journal \
    && dd if=/dev/zero of=/srv/max175/payload bs=1048576 count=2
COPY start.sh /usr/local/bin/max175-start
COPY rsyslog.conf /etc/max175-rsyslog.conf
ENTRYPOINT ["/bin/bash", "/usr/local/bin/max175-start"]
