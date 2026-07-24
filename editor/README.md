# editor/ — Person 2

Cut pipeline: Google Drive folder (or local `clips/`) → auto-editor removes non-talking parts → concat → `output/final.mp4`. Contract in `../CONTRACT.md`.

## Setup

```bash
pip install auto-editor gdown
```

auto-editor bundles ffmpeg. Nothing else needed.

## Run

```bash
# local clips
python editor/cut.py '{"clipsDir":"./clips","instruction":"cut non-talking","marginSec":0.2}'

# pull from Google Drive first (folder must be shared "anyone with link")
python editor/cut.py '{"clipsDir":"./clips","driveUrl":"https://drive.google.com/drive/folders/XXXX","marginSec":0.2}'

# multi-user: ANY user's folder, shared to our service-account email
python editor/cut.py '{"clipsDir":"./clips","driveFolderId":"1AbC...","marginSec":0.2}'
```

Multi-user error codes (agent turns these into reply texts):
`NO_CREDENTIALS` · `NOT_SHARED` (→ "share your folder to <SA email> and resend") · `EMPTY_FOLDER` · `DOWNLOAD_FAILED`.
Get SA email programmatically: `python3 -c "import sys;sys.path.insert(0,'editor');from drive_ingest import service_account_email;print(service_account_email())"`

Output (stdout, per CONTRACT):

```json
{"ok": true, "videoPath": "./output/final.mp4", "durationSec": 42.0}
```

Extra outputs:
- `output/cut_<n>.mp4` — per-clip cuts
- `output/timeline.xml` — Premiere XML of first clip's cut (Person 3 garnish)

## Contract note

`driveUrl` is an OPTIONAL extra field on EditRequest — backward compatible, agent may omit it. CONTRACT.md stays frozen.

## Tuning (noisy salon audio)

If too little gets cut (background music read as "talking"): open `cut.py`, set

```python
AUDIO_THRESHOLD = "0.04"   # try 0.04–0.10, higher = more aggressive
```

If cuts feel choppy, raise margin: `"marginSec": 0.4`.

## Drive gotchas

- Folder MUST be "anyone with the link" — gdown does no OAuth.
- gdown folder limit ~50 files (fine for demo).
- If gdown rate-limits, fallback per file: `curl -L 'https://drive.google.com/uc?id=FILE_ID&export=download' -o clips/1.mp4`
