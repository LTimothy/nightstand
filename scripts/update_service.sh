#!/bin/bash


echo "=== $(date '+%Y-%m-%d %H:%M:%S') Starting update.sh ==="
echo "Sleeping for 3 seconds..."
sleep 3

export PATH="/usr/sbin:/sbin:/usr/bin:/bin"

bash "$(dirname "${BASH_SOURCE[0]}")/update.sh"

