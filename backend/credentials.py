"""Read API keys from the environment or existing local files."""

import os
from pathlib import Path


def key(name: str) -> str:
    if value := os.environ.get(name):
        return value
    path = os.environ.get(name + "_FILE")
    if name == "GEMINI_API_KEY" and not path:
        path = os.environ.get("GEMINI_KEY_FILE")
    if path:
        try:
            return Path(path).read_text().strip()
        except OSError:
            pass
    return ""
