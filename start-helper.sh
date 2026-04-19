#!/usr/bin/env sh
set -eu
node --experimental-strip-types src/main.ts "$@"
