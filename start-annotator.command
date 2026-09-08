#!/bin/zsh
# Launch from the checkout so the app can be started by double-clicking on macOS.
cd "${0:A:h}" || exit 1
exec python3 -m annotator.server
