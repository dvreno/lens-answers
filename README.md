# Lens Answers

A plugin for MemoMind glasses that listens to the conversation around you. When someone asks a question, a
short answer card appears on the lens a few seconds later, with what it heard and where the answer came from.
There is no wake word and nothing to tap.

It is two parts: a plain browser plugin (`phone/`) that streams the glasses microphone, and a small Node
server on your own computer that does the rest. Speech-to-text runs on that computer, so audio stays there.
Only the text of a question goes to the model.

    glasses mic -> phone plugin -> WebSocket -> server on your computer
                                                 Opus decode, cut into sentences, local speech-to-text,
                                                 "is this a question, and where should I look?",
                                                 look it up, write a short answer
    lens card   <- phone plugin <- WebSocket <-  heard / source / answer

The idea comes from EyeCues, an app for Even Realities glasses. Lens Answers is not affiliated with it; it is a
separate project written from scratch for MemoMind glasses.


https://github.com/user-attachments/assets/bcf157c3-c603-41e3-a871-5d2a14f2ced8


## Status

Early, and built for one person's use. It runs in MemoMind Studio: Browser Studio for the plugin page and the
lens, Desktop Studio with the computer's microphone standing in for the glasses microphone. It has not been
tested on real glasses yet. Work mode and the handling of group talk have been checked with typed questions
and synthetic speech only. Expect rough edges; "Known limits" below lists the ones found so far.

## What it answers

| Route | Where the answer comes from | Card source line | On by default |
|---|---|---|---|
| general | the model's own knowledge | `General knowledge` | yes |
| web | a model web search | the first source's host name, or `Web (source not reported)` | yes |
| project | daily briefs of your own software projects | `Your projects · <project>` | when `projects` is set |
| work | your own notes and documents, through a bridge you supply | `KB · <document> <version>, <status>` | when `kb.command` is set |
| statute | a live fetch of Nevada Revised Statutes pages | `leg.state.nv.us · NRS <section>` | no (`statutes.enabled`) |

Follow-up questions work ("how tall is Everest", then "and where is it"): the last few sentences are kept in
memory to resolve words like "it".

For the project, work and statute routes the answer must come from the retrieved passages. If it does not,
the card says `Nothing solid on this one` instead of guessing. A route that is not set up is never offered to
the model, so a question cannot be sent somewhere this server cannot search.

## Quick start

Install two things first: Node 22 or newer, and a way to reach Claude (Claude Code, logged in, or an Anthropic
API key in `ANTHROPIC_API_KEY`). Then:

    git clone https://github.com/dvreno/lens-answers
    cd lens-answers
    npm install
    npm run setup

`npm run setup` walks you through the rest. It asks before it does anything, and each step ends in one line:

1. **MemoMind's Web SDK.** If it is not on your computer, setup offers to fetch it (a `git clone` of
   [plugin-open-platform](https://github.com/memomind-open/plugin-open-platform) next to this folder) and copies
   the SDK into `phone/vendor` (git-ignored; the SDK is MemoMind's and is never committed here).
2. **Your config.** Created at `~/.config/lens-answers/config.json` if you have none. An existing one is never
   overwritten; setup only changes a setting you answer a question about, and says which.
3. **Claude.** You pick Claude Code or an API key, and setup can send one small test question to prove it
   answers. It never asks for the key itself.
4. **Speech-to-text.** Setup sends your speech server a half-second test clip. This is the one part it cannot
   install for you: see "Speech-to-text" below. If your server is at another address, you can type it in.
5. **The plugin.** Setup offers to copy it into the SDK's `examples` folder, where Desktop Studio lists it.
6. **What to type.** It ends with the address to enter on the plugin page and where the token is (it shows
   the token only if you say yes).

```
  ok    Node 22.11.0
  ok    MemoMind Web SDK 0.1.0 copied to phone/vendor
  ok    Config created at ~/.config/lens-answers/config.json
  ok    Model back end: claude-code (the `claude` command is installed)
  ok    Claude answered the test question
  todo  Speech-to-text: nothing answers at http://127.0.0.1:8089. Start your speech server (README, "Speech-to-text").
  note  Notes source: none, so work mode is off. bridge/README.md says how to add one.
```

`todo` lines need doing before the server is useful; `note` lines are optional. Run setup again whenever you
like, or `npm run setup -- --check` to only check and ask nothing.

When it says `Ready`:

    npm start

Open the plugin in Studio, type in the address and token setup gave you, then Save and connect. Say a
question out loud. The server binds `127.0.0.1` only and creates the token file on first start, readable by
you only (mode 600; Windows has no such modes, so there the file is as private as your user folder).

Platforms: the server and its tests are plain Node and are run on macOS, Linux and Windows by the checks in
`.github/workflows/test.yml`. The whole thing working together (speech server, model, Studio) has only been
tried on a Mac so far. Paths in this README are written the macOS and Linux way; on Windows `~` is your user
folder (`C:\Users\you`), so the config is `C:\Users\you\.config\lens-answers\config.json`.

### Speech-to-text

The server posts each sentence (a short WAV file) to an OpenAI-style `/v1/audio/transcriptions` endpoint at
`asr.url`, with the model name `asr.model`, and reads `text` from the JSON reply. Any speech server with that
endpoint should work on any system; set `asr.url` and `asr.model` to match it. Only one has been tried: this
project is developed on a Mac against [audio.cpp](https://github.com/0xShug0/audio.cpp) with Qwen3-ASR:

    brew tap 0xShug0/audio-cpp && brew trust 0xShug0/audio-cpp && brew install audio-cpp
    mkdir -p ~/audio-models && cd ~/audio-models
    audiocpp_model_manager install qwen3_asr_1_7b_q8_0 --models-dir .

with a server config such as `~/audio-models/server.json`:

    {
      "host": "127.0.0.1", "port": 8089, "backend": "metal", "lazy_load": true,
      "models": [
        { "id": "qwen3-asr", "family": "qwen3_asr", "task": "asr", "mode": "offline",
          "path": "/Users/YOU/audio-models/Qwen3-ASR-1.7B-GGUF" }
      ]
    }

    audiocpp_server --config ~/audio-models/server.json &

The first transcription loads a large model (about 15 s measured), and the sentence that triggers it is
lost. Warm the server with one sentence before relying on it.

## Config

Precedence: defaults, then `~/.config/lens-answers/config.json`, then `LENS_*` environment variables
(for example `LENS_PORT`, `LENS_LLM_BACKEND`, `LENS_CALL_MODE`). `~` in paths expands to the home directory.
`config.example.json` is exactly the defaults; delete what you do not change. `server/config.mjs` explains
every setting.

Nothing about you is in this repository. Your notes folder, the words that mark a question as a work question,
and the sentence that tells the model who you are all live in your own config file.

## Your own notes: the work route

The server does not search your notes itself. It starts a program of yours, the bridge, and asks it over a
small JSON-lines protocol. `bridge/README.md` has the protocol and the rules; `kb.command` is how to start
your bridge and `kb.root` is the folder it searches. The server never writes to that folder.

With a bridge set up, three more settings decide which questions go to it:

    "profile": {
      "wearer": "The wearer runs a bicycle repair shop, so questions about repairs, parts or orders are usually \"work\". When unsure between \"work\" and \"general\" or \"web\", choose \"work\".",
      "audience": "someone who runs a bicycle repair shop"
    },
    "routing": { "work": {
      "about": "shop systems, repairs, suppliers, procedures",
      "always": ["\\b(?:gear[\\s-]*hub|spoke[\\s-]*trax)\\b", { "pattern": "\\b(?:ACME|BOLT)\\b", "flags": "" }, "\\bticket\\s*#?\\s*\\d+\\b"],
      "lean": ["\\b(?:derailleurs?|tune[\\s-]*ups?|work\\s+orders?)\\b"]
    } }

- `profile.wearer` is added to the question classifier's instructions as written. `profile.audience` is
  added to the work-mode answer writer's ("…for someone who runs a bicycle repair shop").
- `routing.work.about` is what the classifier is told the work route is for.
- `routing.work.always`: a question matching any of these is a work question, whatever the model said.
  Use it for names that only mean work: products, systems, ticket numbers. Speech-to-text splits and joins
  brand names freely, so allow for both (`gear[\s-]*hub` matches "gearhub", "gear hub" and "Gear-Hub").
- `routing.work.lean`: a match turns a question the model called general or web into a work question. Use it
  for ordinary words that usually mean work for you.
- Each pattern is a regular expression. A plain string ignores case. `{pattern, flags}` with `"flags": ""`
  makes case matter, which is how an acronym that is also a word (BOLT) is told from the word. A pattern
  that is not a valid regular expression stops the server at start, naming the entry but not its text.

A question that names a statute section still goes to the statute lookup when that is on.

## Work mode

Automatic mode (the default) decides per question where to look, and for a work question makes one quick
search: three documents, a short preview of each, the answer model. Work mode is for the times you are being
asked work questions:

| | Automatic mode | Work mode |
|---|---|---|
| Where a question goes | whichever route fits | your notes (a question naming a statute section still goes to the statute lookup) |
| Search | 3 documents, short previews | `work.topK` documents (10), whole matching sections, plus sections that hold every content word of the question (`(keyword match)` on the card) |
| Background | none | a context pack (`work.contextPack`, a notes file inside `kb.root`) as reference notes; a card answered from it reads `KB · Context pack` |
| Model | `llm.answerModel` | `llm.workModel` |
| Second try | none | the model may ask for one more search in its own words (`work.followUp`) |
| End of a sentence | `vad.silenceMs` of quiet (1000 ms) | `work.silenceMs` of quiet (1500 ms) |

Turn it on with the **Work mode** box on the phone page or a long press on the glasses button; the lens status
reads `● work mode`. The phone remembers the choice and asks the server for it again after every reconnect.
Without a bridge there is no work mode and the box stays off.

The answer must still come from the passages or the context pack; otherwise the card says
`Nothing solid on this one`. An answer from the context pack is accepted only with words quoted from it that
are really there. A document's version and status stay on the source line, and the model is told to prefer
current, official documents and to say so when it has to rely on a draft or superseded one.

The context pack is a file you write: your terms, systems, people, known issues. It is read once when the
server starts, kept in memory, and sent to the model back end with each work-mode question. It is never copied,
written to disk or logged (the log line `context-pack chars=N` carries its size only). Restart the server
after the pack or your notes change. A work-mode card takes longer than an automatic one: 500 ms more waiting,
a larger prompt, a slower model, and sometimes a second search and model call.

## Project briefs (optional)

List your software projects in `projects` (`{ "name": "…", "paths": ["~/code/thing"] }`). `npm run briefs`
writes a four-line brief of each (what it is, what it does, status, next) from its `README.md` and any Claude
notes in its `memory/` or `.remember/` folders, into `briefsDir`. Lines that look like credentials are dropped
first. The server answers project questions from those briefs and rebuilds stale ones in the background when
it starts. Building briefs sends those notes to the model back end.

## Model back ends

- `claude-code` (default): runs `claude -p` using your subscription. No API key. If `claude` is not a program
  your system can start directly (on Windows, an npm install of Claude Code is a script, not a program), say
  how to start it in `llm.claudeCommand`, for example `["node", "C:\\path\\to\\claude-code\\cli.js"]`. It is started with
  `--safe-mode`, so your own CLAUDE.md, skills, plugins, hooks and MCP servers are not loaded into the prompt.
  (Measured: without that flag one trivial call carried a prompt of roughly a million tokens.) Each call is
  answered by its own `claude` process over the stream protocol, and the answer is taken the moment the
  model's message ends, without waiting for the program's own wrap-up (measured: about 4.3 s per call
  before, about 1.2 s now). With `llm.warm` (default `true`, `LENS_LLM_WARM=0` turns it off) a started
  process waits ready for the next call of each kind, which takes a call to about 0.8 s. A waiting process
  makes no model call and uses about 260 MB of memory; up to four are kept (one per kind of prompt), each
  answers one call only, and one that has waited more than 15 minutes is replaced instead of used.
- `anthropic-api`: uses the Anthropic SDK; the key comes from the `ANTHROPIC_API_KEY` environment variable.
  Each call fails after 20 s. Not measured yet (no key was available).

Call volume: while listening, every spoken sentence of three or more words costs one model call to decide
whether it is a question (at most two at a time; when both are busy only the newest waiting sentence is kept),
and each question costs one more to write the answer. After three failed calls in a row the lens shows
`answers unavailable` once, until a call succeeds again.

No keys or tokens are stored in this repo.

## Hearing a sentence

The server cuts the microphone stream into sentences by loudness (`server/audio/segmenter.mjs`). A sentence
starts when a 20 ms slice is 3 times louder than the measured background, keeps going while slices stay
1.5 times louder (so soft words and trailing ends do not end it), and ends after `vad.silenceMs` of quiet
(default 1000 ms). The 300 ms before the first loud slice is kept, so a soft first word is not lost. Every
100 ms added to `vad.silenceMs` is 100 ms added to every card; lower it if answers feel slow, raise it if
sentences are still cut at pauses.

People talking together rarely leave a full second of quiet, so a long sentence ends sooner (`vad.shorten`):
once the talk has run 4 s, 400 ms of quiet is enough, and after 8 s, 200 ms. If nobody pauses at all, the clip
is cut at `vad.maxUtteranceMs` (10 s), at the quietest moment of its last 2 s (`vad.cutSearchMs`), and what
follows the cut starts the next clip, so nothing is dropped. A question split by such a cut reaches the model
in two parts; the earlier part is among the context lines of the later one. Work mode changes only the first
wait (`work.silenceMs`); the shorter later waits and the cut are the same in both modes.

While audio arrives the server logs one line every 5 s: `audio chunks=N frames=N undecodable=N peak=N speech=N
quiet=N floor=N` (slices the detector judged speech or quiet, and its background level), and each sentence
is logged as `utterance samples=N end=quiet|max`. Sentences that keep ending by `max` (the length limit) with
almost no quiet slices mean the detector is not finding the gaps between sentences.

## Phone plugin

`phone/` is a plain browser ESM plugin (no bundler). After `npm run setup`:

- Browser Studio: `node <plugin-open-platform>/PhoneSDK/tools/run-browser-studio.mjs --plugin $PWD/phone --port 4173`.
  It shows the plugin page and the lens, but has no microphone.
- Desktop Studio (the MemoMind Plugin Studio app) supplies the computer's microphone as the simulated glasses
  microphone, so the whole path can be tried there. Studio lists every `manifest.json` under
  `<plugin-open-platform>/PhoneSDK/examples/`; `npm run setup` offers to copy `phone/` there as
  `examples/lens-answers` (or copy it yourself), and it needs copying again after the plugin changes. Desktop Studio refuses the microphone while its
  window is not in front, and the plugin does not retry by itself: after restarting the server, click the
  Studio window, then Pause and Resume.
- Real pickup needs the MemoMind app and glasses, which this has not been run on yet.

On the plugin page enter the server address (path `/ws` is added) and the token from the server's token file.
Both are kept in the plugin's `gm.storage` only; the token is sent in the first socket message, never in the URL.

- Glasses button: a press dismisses a card if one is showing, otherwise pauses or resumes listening. A long
  press turns work mode on or off.
- Paused or offline means the microphone is really closed (no audio is buffered or sent).
- Wrong token (close code 4401) or another phone taking over (4409) stops reconnecting and says so on the page.

Lens layout (600x350, one text size): tuned in Browser Studio with worst-case wide text (`W`/`M` runs), nothing clipped.

| Region | id | x | y | width | height | Limit |
|---|---|---|---|---|---|---|
| heard | 1 | 20 | 16 | 560 | 70 | 80 characters |
| source (framed) | 2 | 20 | 96 | 560 | 48 | 60 characters |
| answer | 3 | 20 | 158 | 560 | 150 | 180 characters |
| status | 4 | 440 | 314 | 150 | 28 | n/a |

The limits equal the server's `card.heardMax`, `sourceMax` and `answerMax` defaults; change them together
(`phone/card-layout.js` `REGIONS` and `DEFAULT_LIMITS`, `server/config.mjs`).

## Reaching the server from the phone

The server listens on `127.0.0.1` only. Expose it to your phone with Tailscale rather than opening a port:

    tailscale serve --bg http://127.0.0.1:8790

and enter `wss://<your-computer>.<your-tailnet>.ts.net` as the address on the phone page. Because the server binds
`127.0.0.1` only, a LAN address such as `ws://192.168.x.x:8790` does not reach it; `ws://127.0.0.1:8790` works
only for the Browser Studio simulator on the same computer. The token travels in the first socket message, which
`wss://` encrypts. (This path has not been tested end to end yet.)

## Pause, call mode

- Say "stop listening" (or "pause listening") and the server pauses and the lens shows `paused`. In a short
  sentence (12 words or fewer) the phrase counts anywhere ("okay, stop listening"); in a longer one only at
  the start. Resume with the phone button or the glasses button (a paused microphone cannot hear "resume").
  The pause phrase is recognised from the words alone, so it acts at once even while earlier questions are
  still being answered, and no card follows it.
- "On a call" on the phone page pauses listening for the call and resumes when unticked. Unticking resumes only
  a pause the call started, never one you made with the button or by voice; the Resume button ends any pause.
  Set `callMode` to `true` (or `LENS_CALL_MODE=1`) to keep listening during calls instead.
- Nothing is answered while paused, and the server forgets the recent conversation when it pauses.

## Speech-to-text backup (off by default)

If the local speech server fails, an utterance can be sent to any service with an OpenAI-style
`/v1/audio/transcriptions` endpoint that does not retain audio. Set `asr.backup.enabled` to true, give
`asr.backup.url` and `asr.backup.model`, and put the key in the environment variable named by `asr.backup.keyEnv`
(default `LENS_ASR_BACKUP_KEY`). The server tells the lens as soon as an utterance has gone through the
backup, and the status then reads `listening (backup)` until the local server is used again. With it off,
audio never leaves your computer.

## Privacy rules

- Audio is never written to disk. Sentences live in memory until transcribed.
- Transcripts are held in memory only (the last few lines, for resolving "it" and "that"); nothing is saved.
- Server logs carry event names, route names, counts and timings only: never what was said, asked, answered
  or retrieved.
- Spoken text, passages from your notes, statute pages and web results are treated as data; prompts tell the
  model to ignore instructions inside them.
- The only audio that can leave your computer is through the speech-to-text backup, which is off by default.
- Model calls (understanding the question, writing the answer, building project briefs) go to the model back
  end you chose. Questions routed to the web are sent to a web search.
- With the `claude-code` back end a prompt's instructions are a command-line argument, which other programs
  on your computer can see. Nothing from your notes is ever placed there; passages and the context pack travel in
  the message instead. `profile.wearer`, `profile.audience` and `routing.work.about` are part of those
  instructions, so keep them to what you would not mind another program on your computer reading.
- The token file is mode 600; the token is never put in a URL or a log.
- You are wearing a microphone around other people. Tell them, and check what the law where you are says
  about recording or transcribing a conversation.

## Scripts

- `npm run setup`: the guided setup (above); `npm run setup -- --check` only checks. `npm run sdk` copies
  the Web SDK only.
- `npm run briefs`: build the project briefs (prints project names and written/failed only).
- `node scripts/say-test.mjs "<sentence>"` (macOS only; needs `ffmpeg`): speaks a synthetic sentence at the running server and prints each
  server message with its time from the end of speech. It connects as the one client, replacing the phone.
  `--redact` prints no card text; `--then "<sentence>"` speaks a second sentence on the same connection.
- `npm run eval -- --retrieval-only` or `npm run eval -- --backend claude-code --limit 12`: a text-level run of
  the work-question path for a notes folder that keeps its own question file
  (`<kb.root>/tests/eval/retrieval_eval.yml`, a list of `{id, query, kind, expected: [document paths]}`).
  Prints counts and timings only. Add `--work-mode` to answer the way work mode does, and
  `--work-model <model id>` to try another model.
- `test/studio-smoke.mjs`: Browser Studio smoke test (see the header of the file).
- `test/studio-work-mode.mjs`: Browser Studio check of the work-mode switch, with a fake for every outside
  dependency (no speech server, model or notes).

## Measurements so far

One Mac, the `claude-code` back end, one run each; treat them as rough.

- General-knowledge questions: a card about 2.3 to 3.4 s after the end of speech (six runs, with a 700 ms
  silence wait; the default is now 1000 ms, which adds 0.3 s).
- Group talk with no pauses: a card can take 10 s or more, because a sentence is only cut at
  `vad.maxUtteranceMs`. One synthetic 13.6 s run-on with a question 5 s in was cut at 8.4 s and answered 1.0 s
  after the speech ended.
- Work questions, typed, against the author's own notes (56 questions the notes folder keeps for testing its
  search): automatic mode answered 26 of 43 with a solid card; work mode with `claude-sonnet-5-5` answered 42
  of 42, at a median 2.6 s for search plus answer (5.4 s at the 90th percentile). `claude-opus-5-5` scored the
  same and took 3.9 s. A solid card is not a checked-correct card: 10 of the 42 cited a document other than
  the one the test expected.

## Known limits

- Speech-to-text hears everything nearby: a TV, a podcast or uneven background noise can be picked up as
  speech, and a question asked on a TV can produce a card. The voice-activity cut is a plain energy
  threshold, not speaker recognition.
- The first sentence after the speech server starts is lost while its model loads.
- The model sometimes treats a rhetorical question as a real one (1 of 10 synthetic small-talk lines did), and
  sometimes calls a typed question "not a question" (9 to 13 of 56 in the runs above).
- How good a work answer is depends on your bridge. A wrong top passage can still yield a confident-sounding
  card with that document's name on it. Check the source line.
- A work question the router misses can be answered from general knowledge (or a web search, which sends the
  question text to the search provider). A question forced to `work` that finds nothing in your notes shows
  `Nothing solid on this one`; it never falls through to general knowledge.
- One phone at a time; a second connection replaces the first.
- One text size and brightness on the lens (the Web SDK has no size option); long answers are cut to fit.
- No hosted version and no phone-only version: it needs your own computer running the server.
- Outside macOS only the automated tests have been run. A real session on Linux or Windows, with another
  speech server, has not been tried.

## License

MIT, see `LICENSE`. The MemoMind Web SDK is not part of this repository and stays under MemoMind's own terms.
