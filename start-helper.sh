#!/usr/bin/env sh
set -eu
node --experimental-strip-types src/server.ts "$@"
