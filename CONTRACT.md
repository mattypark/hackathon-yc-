# CONTRACT — frozen at kickoff. Do not edit after push.

## EditRequest (agent → editor)

```json
{ "clipsDir": "./clips", "instruction": "cut non-talking", "marginSec": 0.2 }
```

Invocation: `python editor/cut.py '<EditRequest JSON>'` — prints EditResult JSON to stdout.

## EditResult (editor → agent → messaging)

```json
{ "ok": true, "videoPath": "./output/final.mp4", "durationSec": 42 }
```

On failure: `{ "ok": false, "error": "message" }`

## Messaging surface (Person 1 exposes)

- `POST localhost:4000/send` body: `{ "chatId": "...", "videoPath": "./output/final.mp4", "caption": "done — cut 4 clips down to 42s" }`
- Inbound: messaging forwards every `message.received` to `POST localhost:4001/handle` body: `{ "chatId": "...", "text": "...", "from": "+1..." }`

## Ports

- 4000 — messaging (Linq webhook + send)
- 4001 — agent orchestrator
