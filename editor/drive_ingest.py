#!/usr/bin/env python3
"""
jptr editor — Google Drive service-account ingest (multi-user).

Any user shares THEIR clips folder to the service-account email, texts the
folder link, and this module downloads the videos. One SA serves all users.

Error contract (raised as DriveIngestError with .code):
  NO_CREDENTIALS  — sa-key.json missing / GOOGLE_APPLICATION_CREDENTIALS unset
  NOT_SHARED      — folder not shared to the SA email (or bad folder id)
  EMPTY_FOLDER    — folder reachable but has no video files
  DOWNLOAD_FAILED — network/API failure mid-download

Standalone test:
  python3 editor/drive_ingest.py <FOLDER_ID> [dest_dir]
"""

from __future__ import annotations

import io
import os
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore", category=FutureWarning)

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
VIDEO_MIME_PREFIX = "video/"
DEFAULT_KEY_PATH = Path(__file__).parent / "sa-key.json"


class DriveIngestError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def service_account_email() -> str | None:
    """Read the SA email from the key file so the agent can tell users what to share to."""
    import json
    key_path = _key_path()
    if not key_path:
        return None
    try:
        return json.loads(key_path.read_text()).get("client_email")
    except (OSError, ValueError):
        return None


def _key_path() -> Path | None:
    env = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if env and Path(env).is_file():
        return Path(env)
    if DEFAULT_KEY_PATH.is_file():
        return DEFAULT_KEY_PATH
    return None


def _drive_client():
    key_path = _key_path()
    if not key_path:
        raise DriveIngestError(
            "NO_CREDENTIALS",
            "service-account key not found (set GOOGLE_APPLICATION_CREDENTIALS or add editor/sa-key.json)",
        )
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(str(key_path), scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def download_folder(folder_id: str, dest: Path) -> list[Path]:
    """Download all video files from a Drive folder shared to the SA. Returns local paths."""
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaIoBaseDownload

    drive = _drive_client()
    dest.mkdir(parents=True, exist_ok=True)

    try:
        resp = drive.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="files(id, name, mimeType, size)",
            pageSize=100,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
    except HttpError as exc:
        if exc.resp.status in (403, 404):
            raise DriveIngestError(
                "NOT_SHARED",
                f"folder {folder_id} not accessible — share it to the service-account email",
            ) from exc
        raise DriveIngestError("DOWNLOAD_FAILED", f"Drive list failed: {exc}") from exc

    videos = [f for f in resp.get("files", []) if f.get("mimeType", "").startswith(VIDEO_MIME_PREFIX)]
    if not videos:
        raise DriveIngestError("EMPTY_FOLDER", f"no video files in folder {folder_id}")

    downloaded: list[Path] = []
    for f in videos:
        target = dest / f["name"]
        try:
            request = drive.files().get_media(fileId=f["id"])
            with io.FileIO(target, "wb") as fh:
                downloader = MediaIoBaseDownload(fh, request, chunksize=10 * 1024 * 1024)
                done = False
                while not done:
                    _, done = downloader.next_chunk()
        except HttpError as exc:
            raise DriveIngestError("DOWNLOAD_FAILED", f"download failed for {f['name']}: {exc}") from exc
        downloaded.append(target)

    return downloaded


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: drive_ingest.py <FOLDER_ID> [dest_dir]", file=sys.stderr)
        sys.exit(2)
    folder = sys.argv[1]
    dest_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("./clips")
    try:
        files = download_folder(folder, dest_dir)
        print(f"downloaded {len(files)} videos -> {dest_dir}")
        for p in files:
            print(f"  {p.name}")
    except DriveIngestError as err:
        print(f"[{err.code}] {err}", file=sys.stderr)
        sys.exit(1)
