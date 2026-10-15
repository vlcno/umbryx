#!/bin/sh
# Starts the Umbryx server on macOS or Linux.
cd "$(dirname "$0")" || exit 1
exec python3 server.py
