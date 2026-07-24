#!/usr/bin/env python3
"""
jptr editor — Person 2
Pipeline: (optional) Google Drive folder download -> auto-editor cut non-talking -> concat -> output/final.mp4

Usage (per CONTRACT.md):
  python editor/cut.py '{"clipsDir":"./clips","instruction":"cut non-talking","marginSec":0.2}'
  python editor/cut.py '{"clipsDir":"./clips","driveUrl":"https://drive.google.com/drive/folders/XXXX","marginSec":0.2}'

Prints EditResult JSON to stdout:
  {"ok": true, "videoPath": "./output/final.mp4", "durationSec": 42}
  {"ok": false, "error": "..."}

Deps: pip install auto-editor gdown   (auto-editor bundles ffmpeg)
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
OUTPUT_DIR = Path("./output")
DEFAULT_MARGIN_SEC = 0.2
# Tuning knob for noisy footage (salon background music etc.).
# Higher threshold = more aggressive cutting. Try 0.04-0.10 if too little gets cut.
AUDIO_THRESHOLD = None  # e.g. "0.04" -> passes --edit audio:threshold=0.04


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def download_drive_folder(drive_url: str, clips_dir: Path) -> None:
    """Pull all files from a link-shared Drive folder into clips_dir (no OAuth)."""
    clips_dir.mkdir(parents=True, exist_ok=True)
    result = run(["gdown", "--folder", drive_url, "-O", str(clips_dir)])
    if result.returncode != 0:
        fail(f"gdown failed: {result.stderr.strip()[:500]}")
    # gdown may nest files inside a subfolder named after the Drive folder — flatten.
    for sub in [p for p in clips_dir.iterdir() if p.is_dir()]:
        for item in sub.iterdir():
            target = clips_dir / item.name
            if not target.exists():
                shutil.move(str(item), str(target))
        shutil.rmtree(sub, ignore_errors=True)


def find_clips(clips_dir: Path) -> list[Path]:
    return sorted(p for p in clips_dir.iterdir() if p.suffix.lower() in VIDEO_EXTS)


def cut_clip(clip: Path, index: int, margin_sec: float) -> Path:
    out = OUTPUT_DIR / f"cut_{index}.mp4"
    cmd = ["auto-editor", str(clip), "--margin", f"{margin_sec}sec", "--no-open", "-o", str(out)]
    if AUDIO_THRESHOLD:
        cmd += ["--edit", f"audio:threshold={AUDIO_THRESHOLD}"]
    result = run(cmd)
    if result.returncode != 0 or not out.exists():
        fail(f"auto-editor failed on {clip.name}: {result.stderr.strip()[:500]}")
    return out


def concat_clips(cuts: list[Path]) -> Path:
    final = OUTPUT_DIR / "final.mp4"
    if len(cuts) == 1:
        shutil.copy(cuts[0], final)
        return final
    list_file = OUTPUT_DIR / "concat.txt"
    list_file.write_text("".join(f"file '{c.resolve()}'\n" for c in cuts))
    # Re-encode concat: clip resolutions/codecs may differ across phone recordings.
    result = run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", str(final),
    ])
    if result.returncode != 0 or not final.exists():
        fail(f"ffmpeg concat failed: {result.stderr.strip()[:500]}")
    return final


def probe_duration(video: Path) -> float:
    result = run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(video),
    ])
    try:
        return round(float(result.stdout.strip()), 1)
    except ValueError:
        return 0.0


def export_premiere_timeline(first_clip: Path, margin_sec: float) -> None:
    """Garnish for Person 3 — Premiere XML of the cut. Non-fatal if it fails."""
    run([
        "auto-editor", str(first_clip), "--margin", f"{margin_sec}sec",
        "--export", "premiere", "--no-open", "-o", str(OUTPUT_DIR / "timeline.xml"),
    ])


def main() -> None:
    if len(sys.argv) < 2:
        fail("missing EditRequest JSON arg")
    try:
        request = json.loads(sys.argv[1])
    except json.JSONDecodeError as exc:
        fail(f"bad EditRequest JSON: {exc}")

    clips_dir = Path(request.get("clipsDir", "./clips"))
    margin_sec = float(request.get("marginSec", DEFAULT_MARGIN_SEC))
    drive_url = request.get("driveUrl")

    OUTPUT_DIR.mkdir(exist_ok=True)

    if drive_url:
        download_drive_folder(drive_url, clips_dir)

    if not clips_dir.is_dir():
        fail(f"clips dir not found: {clips_dir}")
    clips = find_clips(clips_dir)
    if not clips:
        fail(f"no video files in {clips_dir}")

    cuts = [cut_clip(clip, i, margin_sec) for i, clip in enumerate(clips)]
    final = concat_clips(cuts)
    export_premiere_timeline(clips[0], margin_sec)

    print(json.dumps({
        "ok": True,
        "videoPath": f"./{final.as_posix()}",
        "durationSec": probe_duration(final),
    }))


if __name__ == "__main__":
    main()
