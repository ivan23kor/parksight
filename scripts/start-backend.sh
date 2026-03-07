#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_PORT="${BACKEND_PORT:-8000}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to start the backend."
  exit 1
fi

if command -v uv >/dev/null 2>&1; then
  if [ ! -x "$ROOT_DIR/.venv/bin/python" ]; then
    uv venv "$ROOT_DIR/.venv"
  fi
  "$ROOT_DIR/.venv/bin/python" -m pip show fastapi >/dev/null 2>&1 || \
    uv pip install --python "$ROOT_DIR/.venv/bin/python" -r "$ROOT_DIR/backend/requirements.txt"
else
  if [ ! -x "$ROOT_DIR/.venv/bin/python" ]; then
    python3 -m venv "$ROOT_DIR/.venv"
  fi
  "$ROOT_DIR/.venv/bin/python" -m pip show fastapi >/dev/null 2>&1 || \
    "$ROOT_DIR/.venv/bin/python" -m pip install -r "$ROOT_DIR/backend/requirements.txt"
fi

exec "$ROOT_DIR/.venv/bin/python" -m uvicorn backend.main:app --host 127.0.0.1 --port "$BACKEND_PORT"
