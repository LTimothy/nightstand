#!/bin/bash


# --- Variables ---

# Get the Python version and extract major, minor, and incremental version numbers
PYTHON_VERSION=$(python3 --version | awk '{print $2}')
MAJOR_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f1-2)
MAJOR_MINOR_INCREMENTAL_VERSION=$(echo "$PYTHON_VERSION" | cut -d. -f1-3)

# Check if a Python version was successfully retrieved
if [ -z "$PYTHON_VERSION" ] || [ "$PYTHON_VERSION" = "unknown" ]; then
    echo "Error: Could not determine the installed Python version."
    exit 1
fi


REPO_URL="https://github.com/python/cpython/archive/refs/tags/v${MAJOR_MINOR_INCREMENTAL_VERSION}.zip"
# Root copies from here into the system Python, so only root may reach it.
SYSTEM_DIR="${NIGHTSTAND_SYSTEM_DIR:-/usr/local/lib/nightstand}"
TARGET_DIR=$(mkdir -p "$SYSTEM_DIR" && mktemp -d "$SYSTEM_DIR/.download.XXXXXX") \
  || { echo "Error: could not create a private work folder in $SYSTEM_DIR"; exit 1; }
trap 'rm -rf "$TARGET_DIR"' EXIT
ZIP_FILE="$TARGET_DIR/cpython_lib.zip"

PYTHON_LIB_DIR=$(python3 -I -c 'import sysconfig; print(sysconfig.get_paths()["stdlib"])')

# --- 1. Download and Unzip ---

echo "Downloading CPython Lib for version ${MAJOR_MINOR_INCREMENTAL_VERSION}..."
echo "Using URL: $REPO_URL"
curl -L -o "$ZIP_FILE" "$REPO_URL"

# Check if download was successful
if [ $? -ne 0 ]; then
    echo "Error: Failed to download CPython Lib from $REPO_URL"
    exit 1
fi


echo "Unzipping..."
unzip -o -q "$ZIP_FILE" -d "$TARGET_DIR/tree"

# Check if unzip was successful
if [ $? -ne 0 ]; then
  echo "Error unzipping cpython_lib.zip"
  exit 1
fi

echo "Removing zip file..."
rm "$ZIP_FILE"

# --- 2. Copy Files (No Overwrite) ---

echo "Copying new files to $PYTHON_LIB_DIR..."

# Find the actual Lib directory (handle potential variations in the extracted folder name)
ACTUAL_LIB_DIR=$(find "$TARGET_DIR/tree" -type d -name "Lib" -print -quit)

if [ -z "$ACTUAL_LIB_DIR" ]; then
    echo "Error: Could not find the Lib directory within $TARGET_DIR"
    exit 1
fi

find "$ACTUAL_LIB_DIR" -type f -print0 | while IFS= read -r -d $'\0' file; do
    # Construct the destination path relative to the Lib directory itself
    relative_path=$(echo "$file" | sed "s|$ACTUAL_LIB_DIR/||")
    dest_file="$PYTHON_LIB_DIR/$relative_path"
    dest_dir=$(dirname "$dest_file")


    # Check if the destination *directory* exists.  If not, create it.
    if [[ ! -d "$dest_dir" ]]; then
        echo "Creating directory: $dest_dir"
        mkdir -p "$dest_dir"  # -p creates parent directories as needed
    fi

    # Check if the file already exists
    if [[ ! -f "$dest_file" ]]; then
        cp -v "$file" "$dest_file"
    fi
done

rm -rf "$TARGET_DIR" # Use -rf for recursive force removal


echo "Done setting up python installation"


