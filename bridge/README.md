# The notes bridge

Lens Answers does not search your notes itself. It starts one program of yours, the bridge, and asks it.
That keeps the search yours: a folder of Markdown files, a database, a vector index, anything.

Tell the server how to start it in `~/.config/lens-answers/config.json`:

    "kb": {
      "root": "~/notes",
      "command": ["python3", "~/bridges/my_bridge.py"],
      "env": { "PYTHONPATH": "~/notes/lib" },
      "timeoutMs": 4000
    }

- `command` is the program and its arguments. With no `command` there is no notes source: the classifier
  is never offered the work route and the phone's work-mode box stays off.
- `root` reaches the bridge as the environment variable `KB_ROOT`. `env` adds more variables. A leading `~`
  is expanded in `root`, in every part of `command`, and in every entry of a colon-separated `env` value.
- The bridge runs with this repository as its working folder, never the notes folder, and with
  `PYTHONDONTWRITEBYTECODE=1` so a Python bridge leaves no `.pyc` files beside your notes.

## Protocol

The bridge is started once and kept running. It reads one JSON object per line on standard input and writes
one JSON object per line on standard output. Anything it writes to standard error is discarded.

Request:

    {"id": 7, "query": "how long do returns take", "top_k": 3}
    {"id": 8, "query": "how long do returns take", "top_k": 10, "full": true, "exact": true}

| Field | Meaning |
|---|---|
| `id` | Echo it in the reply. Replies may come back in any order. |
| `query` | The question, as rewritten by the classifier. |
| `top_k` | How many documents to return at most: 3 on the quick path, `work.topK` (10) in work mode. |
| `full` | Work mode only. Each excerpt should be the whole matching section, not a short preview. |
| `exact` | Work mode only. Also return `exact`: sections that hold every content word of the query. |

Reply:

    {"id": 7, "mode": "hybrid", "results": [
      {"source_path": "guides/returns.md", "title": "Returns guide", "version": "v02", "status": "current",
       "section": "Timing", "excerpts": ["Returns are processed within five working days."]}
    ]}

| Field | Meaning |
|---|---|
| `mode` | `"none"` means nothing was found. `"keyword_only"` marks every card `(keyword match)`. Any other word is treated as a normal result. |
| `results` | Best first, one per document. |
| `results[].title` | Shown on the card's source line, as `KB · <title> <version>, <status>`. |
| `results[].version`, `status` | Optional. Shown on the source line; work mode tells the model to prefer current documents over draft or superseded ones. |
| `results[].excerpts` | A list of strings; they are joined and cut to the passage limit. |
| `results[].source_path` | Optional. Used to avoid repeating a document; never shown. |
| `exact` | Optional, same shape as `results`. Appended after them and marked `(keyword match)`. |
| `error` | Optional. Ignored, apart from the reply then usually having `"mode": "none"`. |

## Rules the server relies on

- Answer every request, or the question waits for `kb.timeoutMs` and then shows `Nothing solid on this one`.
  A bridge that misses the timeout is killed and started again on the next question.
- A line on standard output that is not JSON fails every request in flight.
- The server sends one warm-up query at start (`"warm up the search index"`) and waits up to 20 s for it, so
  a slow first load does not cost the first real question.
- Open your notes read-only. The server never writes to `kb.root`; the bridge should not either.
- Do not log queries or results. The server's own log holds counts and timings only.

The smallest working bridge is the test fake, `test/helpers/fake-kb-bridge.mjs`.
