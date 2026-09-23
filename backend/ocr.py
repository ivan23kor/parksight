"""Read one human-selected parking sign with Gemini 3.5 Flash-Lite."""

import hashlib
import json

import httpx

from backend.credentials import key


MODEL = "gemini-3.5-flash-lite"
PROMPT = """Read the visible Canadian curbside sign in this image. Do not guess hidden or unreadable text.
Return JSON with: is_parking_sign (boolean), raw_text (verbatim visible text), confidence
(high, medium, or low), and rules (array). Each rule has category (parking, no_parking,
no_stopping, loading, taxi, permit, or other), description (plain English including
visible days and times), arrow_direction (left, right, both, or unknown), and
max_minutes (number or null). Keep separate plates as separate rules. If the image
is not a parking sign, return is_parking_sign=false and an empty rules array."""
_cache: dict[str, dict] = {}


async def read_sign(client: httpx.AsyncClient, image_base64: str) -> dict:
    api_key = key("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("Gemini is not configured")
    if len(image_base64) > 6_000_000:
        raise ValueError("Sign image is too large")
    digest = hashlib.sha256(image_base64.encode()).hexdigest()
    if digest in _cache:
        return _cache[digest]

    response = await client.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        headers={"x-goog-api-key": api_key},
        json={
            "contents": [{"parts": [
                {"inlineData": {"mimeType": "image/jpeg", "data": image_base64}},
                {"text": PROMPT},
            ]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "maxOutputTokens": 1024,
                "thinkingConfig": {"thinkingLevel": "minimal"},
            },
        },
        timeout=45,
    )
    response.raise_for_status()
    payload = response.json()
    candidate = payload.get("candidates", [{}])[0]
    if candidate.get("finishReason") != "STOP":
        raise ValueError("Gemini did not finish the sign reading")
    parts = candidate.get("content", {}).get("parts", [])
    content = "".join(part.get("text", "") for part in parts if isinstance(part, dict) and not part.get("thought"))
    content = content.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    result = json.loads(content)
    if not isinstance(result, dict) or not isinstance(result.get("is_parking_sign"), bool):
        raise ValueError("Gemini returned an invalid sign reading")
    rules = result.get("rules")
    result["rules"] = [rule for rule in rules if isinstance(rule, dict)] if isinstance(rules, list) else []
    result["raw_text"] = str(result.get("raw_text") or "")
    result["confidence"] = result.get("confidence") if result.get("confidence") in ("high", "medium", "low") else "low"
    result["model"] = MODEL
    if len(_cache) >= 128:
        _cache.pop(next(iter(_cache)))
    _cache[digest] = result
    return result
