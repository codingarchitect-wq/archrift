#!/bin/bash
# Shared helpers.

log() {
  echo "[$(date +%T)] $*"
}

function die {
  log "$*" >&2
  exit 1
}
