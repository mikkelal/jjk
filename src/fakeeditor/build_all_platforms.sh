#!/bin/sh
set -eu

if [ "$(uname -s)" = Darwin ]; then
  # Use Zig's bundled libc; newer macOS SDK stubs fail to link with Zig 0.15.
  export DEVELOPER_DIR=/nonexistent
fi

for target in aarch64-macos x86_64-macos arm-linux aarch64-linux x86_64-linux aarch64-windows x86_64-windows; do
  uvx --from ziglang==0.15.2 python-zig build -Doptimize=ReleaseSmall -Dtarget="$target" --release=small --summary all
done
