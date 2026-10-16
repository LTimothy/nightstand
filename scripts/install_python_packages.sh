#!/bin/bash

set -e

# Root copies these into the system Python, so they come from the root-owned copy.
BUNDLED="$(dirname "${BASH_SOURCE[0]}")/python"
PYTHON_VERSION_DOT=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}{sys.version_info.minor}")')

if [ "$PYTHON_VERSION" = "39" ]; then
  echo "Detected python version 3.9"
  # Pod 3 with SD card has python version 3.9 & is missing venv
  cp -r "$BUNDLED"/$PYTHON_VERSION/venv /usr/lib/python$PYTHON_VERSION_DOT/
  cp "$BUNDLED"/plistlib.py /usr/lib/python$PYTHON_VERSION_DOT/
  cp "$BUNDLED"/pyexpat.cpython-$PYTHON_VERSION-aarch64-linux-gnu.so /usr/lib/python$PYTHON_VERSION_DOT/
  echo "Copied files for Pod 3 with SD card successfully."
elif [ "$PYTHON_VERSION" = "310" ]; then
  echo "Detected python version 3.10"
  cp "$BUNDLED"/plistlib.py /usr/lib64/python$PYTHON_VERSION_DOT/
  cp "$BUNDLED"/pyexpat.cpython-$PYTHON_VERSION-aarch64-linux-gnu.so /usr/lib64/python$PYTHON_VERSION_DOT/
  echo "Copied files successfully"
else
  echo -e "\033[33mWARNING: Detected python version $PYTHON_VERSION_DOT \033[0m"
  echo -e "\033[33mWARNING: Biometrics may or may not work!! \033[0m"
fi

echo "Creating new python venv..."
python3 -m venv /home/dac/venv

echo "Activating python venv..."
source /home/dac/venv/bin/activate

set -x
/home/dac/venv/bin/python -m pip install -r /home/dac/free-sleep/scripts/python/requirements.txt
set +x
