#!/bin/bash
set -e
cd "$(dirname "$0")/.."
exec npm --prefix product start
