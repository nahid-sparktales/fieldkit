#!/bin/sh
set -eu

# Finish the signature update before clamd loads its database. Starting both at
# once can miss NotifyClamd before the socket exists and leave an old engine
# behind a new on-disk database that SelfCheck considers unchanged.
echo "Updating scanner signatures before starting clamd"
/bin/sh /init freshclam --foreground --stdout

# Keep the pinned image's ownership/config setup and background update service.
# Compose supplies the init process; bypass /init's nested tini shebang.
exec /bin/sh /init
