# editor/ — Person 2 Technical Implementation

Owns clip ingest (Google Drive / local) + the cut pipeline. Pure CLI, no server. Contract: [../CONTRACT.md](../CONTRACT.md) (frozen) + optional fields in [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Current state

- ✅ `cut.py` DONE + smoke-tested: synthetic 12s clip (alternating 2s tone/2s silence) → 7.1s output. Non-talking removal + concat + ffprobe duration + Premiere XML garnish all working.
- ✅ gdown link-share ingest working (`driveUrl` field).
- ⬜ `drive_ingest.py` — service-account Drive download (`driveFolderId` field). THIS is the remaining build.

## Setup

```bash
pip install auto-editor gdown google-api-python-client google-auth
# scripts land in ~/Library/Python/3.9/bin — add to PATH
```

## Step 0 — Google Drive service-account auth (the "connect your Drive" flow)

One-time (10–15 min):
1. [console.cloud.google.com](https://console.cloud.google.com) → new project `jptr` → APIs & Services → enable **Google Drive API**.
2. IAM & Admin → Service Accounts → create `jptr-editor` (no roles needed) → Keys tab → Add key → JSON → save as `editor/sa-key.json`.
3. **`sa-key.json` is gitignored. Never commit it.** Set `GOOGLE_APPLICATION_CREDENTIALS=./editor/sa-key.json`.

Per-user "account link" (what the demo shows):
4. User shares their Drive clips folder with the SA email `jptr-editor@<project>.iam.gserviceaccount.com` as **Viewer**. That share = the connection. No OAuth screens.
5. Folder ID = the long token in the folder URL: `drive.google.com/drive/folders/<FOLDER_ID>`.

## `drive_ingest.py` (to build, ~40 lines)

```python
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

def download_folder(folder_id: str, dest: Path) -> list[Path]:
    creds = service_account.Credentials.from_service_account_file(
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"], scopes=SCOPES)
    drive = build("drive", "v3", credentials=creds)
    resp = drive.files().list(
        q=f"'{folder_id}' in parents and mimeType contains 'video/'",
        fields="files(id,name,size)").execute()
    out = []
    for f in resp["files"]:
        target = dest / f["name"]
        req = drive.files().get_media(fileId=f["id"])
        with open(target, "wb") as fh:
            dl = MediaIoBaseDownload(fh, req)
            done = False
            while not done:
                _, done = dl.next_chunk()
        out.append(target)
    return out
```

Wire into `cut.py` `main()`: if `request.get("driveFolderId")` → `download_folder(...)` before `find_clips`. Keep existing `driveUrl` (gdown) and bare-local paths untouched — the three ingest modes are:

| EditRequest field | Path | Auth |
|---|---|---|
| `driveFolderId` | service account API download | SA JSON + folder shared to SA email |
| `driveUrl` | gdown | folder public "anyone with link" |
| neither | `clips/` already filled (drag-drop upload via messaging `/upload`) | none |

## Pipeline internals (already built — reference)

- Per clip: `auto-editor <clip> --margin {marginSec}sec --no-open -o output/cut_<n>.mp4`
- Margin keeps 0.2s around speech so cuts don't clip words. Raise to 0.4 if choppy.
- Noisy salon audio (background music misread as talking): set `AUDIO_THRESHOLD = "0.04"` in cut.py → adds `--edit audio:threshold=0.04`. Try 0.04–0.10.
- Concat: ffmpeg concat demuxer with **re-encode** (`libx264 veryfast + aac`) — phone clips vary in resolution/codec; stream-copy concat would corrupt.
- Duration: ffprobe on final.
- Garnish: `--export premiere -o output/timeline.xml` (first clip) for Person 3's Premiere wow-shot.
- All failures → `{"ok":false,"error":"..."}` JSON on stdout, exit 1. Never raw tracebacks (agent parses stdout).

## Test gates

```bash
# SA ingest (after step 0)
python3 editor/cut.py '{"clipsDir":"./clips","driveFolderId":"<FOLDER_ID>","marginSec":0.2}'
# gdown fallback
python3 editor/cut.py '{"clipsDir":"./clips","driveUrl":"https://drive.google.com/drive/folders/<ID>","marginSec":0.2}'
# local
python3 editor/cut.py '{"clipsDir":"./clips","marginSec":0.2}'
```

Pass = `{"ok":true,...}` + `output/final.mp4` plays with silence gone. **Test on REAL salon footage ASAP** — synthetic passed, real audio is the risk.

## Env

```bash
GOOGLE_APPLICATION_CREDENTIALS=./editor/sa-key.json
DRIVE_FOLDER_ID=   # convenience for testing
```
