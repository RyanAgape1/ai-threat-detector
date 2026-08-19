"""
Real audio analysis: RMS-based volume detection + OpenAI Whisper transcription.
Replaces the fake motion-derived audio events.
"""
import asyncio
import io
import os
import wave
from typing import Callable, List, Optional

import numpy as np
from openai import AsyncOpenAI

from models import DetectionEvent

# ── Client ─────────────────────────────────────────────────────────────────

_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    return _client


# ── Thresholds ──────────────────────────────────────────────────────────────

SILENCE_RMS   = 0.005   # below this → skip Whisper, emit nothing
ELEVATED_RMS  = 0.035   # above this → elevated_noise candidate
LOUD_RMS      = 0.09    # above this + shout keyword → shouting_detected

SHOUT_KEYWORDS = {
    'help', 'stop', 'fire', 'no', 'hey', 'alarm', 'emergency',
    'run', 'threat', 'gun', 'bomb', 'fight', 'assault', 'attack',
    'thief', 'police', 'call 911', 'get off',
}


# ── Core helpers ────────────────────────────────────────────────────────────

def _rms_from_wav_bytes(wav_bytes: bytes) -> float:
    try:
        with wave.open(io.BytesIO(wav_bytes)) as wf:
            raw = wf.readframes(wf.getnframes())
            arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            return float(np.sqrt(np.mean(arr ** 2))) if len(arr) else 0.0
    except Exception:
        return 0.0


async def _transcribe(audio_bytes: bytes, filename: str) -> Optional[str]:
    """Call Whisper API on any audio format the API supports (wav, webm, mp4…)."""
    try:
        buf = io.BytesIO(audio_bytes)
        buf.name = filename
        result = await _get_client().audio.transcriptions.create(
            model="whisper-1",
            file=buf,
            response_format="text",
        )
        text = (result or "").strip()
        return text if text else None
    except Exception as exc:
        # Swallowing this silently made a dead API key look like a quiet room.
        print(f"[audio] transcription failed: {type(exc).__name__}: {exc}")
        return None


def _events_from_rms_and_transcript(
    rms: float,
    transcript: Optional[str],
    extra_meta: Optional[dict] = None,
    peak: Optional[float] = None,
) -> List[DetectionEvent]:
    """Build events from a chunk's loudness and what was said in it.

    `rms` is the mean across the whole chunk and decides sustained loudness.
    `peak` is the loudest moment within it, which is what the shout gate wants —
    a two-second mean washes out a one-second shout. Defaults to `rms` for
    callers that only measure the mean.
    """
    peak = rms if peak is None else max(peak, rms)

    meta: dict = {"rms": round(rms, 4)}
    if peak > rms:
        meta["rms_peak"] = round(peak, 4)
    if transcript:
        meta["transcript"] = transcript[:200]
    if extra_meta:
        meta.update(extra_meta)

    text_lower = (transcript or "").lower()
    has_shout_word = any(kw in text_lower for kw in SHOUT_KEYWORDS)

    if peak >= LOUD_RMS and has_shout_word:
        return [DetectionEvent(
            source="audio", type="shouting_detected",
            confidence=min(0.93, 0.55 + rms * 2),
            metadata=meta,
        )]

    if rms >= ELEVATED_RMS or (rms >= SILENCE_RMS and has_shout_word):
        return [DetectionEvent(
            source="audio", type="elevated_noise",
            confidence=min(0.82, 0.35 + rms * 4),
            metadata=meta,
        )]

    return []  # quiet — emit nothing


# ── Live camera audio ────────────────────────────────────────────────────────

async def analyze_audio_chunk(
    audio_bytes: bytes,
    filename: str,
    rms_hint: float,
    peak_hint: float = 0.0,
) -> List[DetectionEvent]:
    """
    Analyze a browser-recorded audio chunk.
    rms_hint is the browser's mean RMS across the chunk, peak_hint its loudest
    moment. We rely on those for volume (WebM can't be decoded by the wave
    module) and on Whisper for content.
    """
    loudest = max(rms_hint, peak_hint)
    if loudest < SILENCE_RMS:
        print(f"[audio] rms={rms_hint:.4f} peak={peak_hint:.4f} - below silence gate, skipped")
        return []

    transcript = await _transcribe(audio_bytes, filename)
    events = _events_from_rms_and_transcript(rms_hint, transcript, peak=peak_hint)
    print(
        f"[audio] rms={rms_hint:.4f} peak={peak_hint:.4f} "
        f"transcript={transcript!r} -> {[e.type for e in events] or 'no events'} "
        f"(gates: elevated>={ELEVATED_RMS} loud>={LOUD_RMS})"
    )
    return events


# ── Uploaded-video audio ─────────────────────────────────────────────────────

async def process_video_audio(
    video_path: str,
    ingest_fn: Callable,
) -> None:
    """
    Extract audio from a video file using ffmpeg, analyze each 2-second segment
    with Whisper + RMS, and inject real audio DetectionEvents.
    Silently no-ops when ffmpeg is not installed or the video has no audio track.
    Uses asyncio subprocess so it never blocks the event loop.
    """
    wav_path = video_path + "_audio.wav"
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-ac", "1", "-ar", "16000",
            "-f", "wav", wav_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            proc.kill()
            return
        if proc.returncode != 0 or not os.path.exists(wav_path):
            return
    except FileNotFoundError:
        return  # ffmpeg not installed — skip audio analysis

    try:
        segments = _split_wav(wav_path)
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass

    for _start_time, wav_bytes in segments:
        rms = _rms_from_wav_bytes(wav_bytes)
        transcript: Optional[str] = None
        if rms >= SILENCE_RMS:
            transcript = await _transcribe(wav_bytes, "segment.wav")
        events = _events_from_rms_and_transcript(rms, transcript)
        for event in events:
            await ingest_fn(event)
        # Pace at roughly half of 2x real-time (video frames use 0.25 s per 0.5 s of video)
        await asyncio.sleep(0.5)


def _split_wav(wav_path: str, segment_seconds: float = 2.0) -> List[tuple]:
    segments: List[tuple] = []
    try:
        with wave.open(wav_path, "rb") as wf:
            rate = wf.getframerate()
            channels = wf.getnchannels()
            width = wf.getsampwidth()
            frames_per_seg = int(rate * segment_seconds)
            total = wf.getnframes()
            pos = 0
            while pos < total:
                wf.setpos(pos)
                raw = wf.readframes(frames_per_seg)
                if not raw:
                    break
                buf = io.BytesIO()
                with wave.open(buf, "wb") as out:
                    out.setnchannels(channels)
                    out.setsampwidth(width)
                    out.setframerate(rate)
                    out.writeframes(raw)
                segments.append((pos / rate, buf.getvalue()))
                pos += frames_per_seg
    except Exception:
        pass
    return segments
