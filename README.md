# Eloy City Council Summary Widget

A widget for the City of Eloy website (eloyaz.gov) that shows plain-language summaries of recent City Council meetings. Nothing reaches the website until a staff member reviews and approves it.

```
Granicus video archive ──► Review app (staff PC) ──► GitHub: widget/data/meetings.json ──► GitHub Pages ──► iframe on eloyaz.gov
                           transcribe, summarize,       commit triggers deploy
                           review, edit, approve
```

- **Granicus** (`eloyaz.granicus.com`) is the City's public archive of meeting video, agendas, and minutes. The review app reads its listing for new recordings. Granicus has no summaries, so the app makes one: it streams the recording's audio through the bundled ffmpeg, transcribes it with Deepgram, reads the posted agenda, and asks Claude for a short plain-language summary.
- **Review app** (`review-app/`, Electron) lists new recordings, hides tests automatically, and flags recordings to check closely: other boards, duplicate recordings of one date, very short recordings. The reviewer writes the summary with Claude (or by hand), edits, approves, and publishes.
- **Widget** (`widget/`) is a static page: the latest meeting with an overview, a "Read the full summary" expander and a video link, then earlier meetings, plus a "not the official minutes" note.

## Folders

| Folder | What is in it |
| --- | --- |
| `widget/` | The website widget, deployed as-is to GitHub Pages. `data/meetings.json` holds the approved summaries and is written only by the review app. |
| `review-app/` | Staff review app. `main/engine/` holds the Granicus client, ffmpeg audio, Deepgram transcription, transcript files, Claude summary, review workflow, and GitHub publishing. |
| `review-app/resources/keyterms.txt` | Names Deepgram should spell correctly. Update it when Council or staff change. |
| `review-app/test-fixtures/` | Saved Granicus pages and a sample Deepgram response for the offline test. |
| `tools/preview-widget.js` | Previews the widget locally, optionally with sample data. |
| `samples/` | Sample data for the local preview. Kept out of git (`.gitignore`). |
| `.github/workflows/pages.yml` | Deploys `widget/` to GitHub Pages on every change. |

## One-time setup

1. **Repository.** [`City-of-Eloy/city-council-widget`](https://github.com/City-of-Eloy/city-council-widget) is public. It contains no keys or tokens. Every version of the published summaries stays visible in its history, so review carefully before publishing. In Settings → Code security, turn on **Secret scanning** and **Push protection**. Commit with your GitHub "noreply" email address rather than a City address.
2. **Turn on Pages.** In the repository, open Settings → Pages and set Source to **GitHub Actions**. The widget is then served at `https://city-of-eloy.github.io/city-council-widget/`.
3. **Keys.** In the review app's Settings on each reviewer's PC, paste three secrets. They are encrypted for that Windows account (Electron `safeStorage`, Windows DPAPI) and never leave the PC. The installer contains no keys.
   - **Anthropic API key.** Claude Opus 5.5 writes each summary from the transcript and agenda. Use a dedicated Console workspace with a monthly spend limit. One summary sends one meeting transcript.
   - **Deepgram API key.** Transcribes the recording (Nova-3 with speaker separation; about $0.0043 per minute, roughly $0.40 for a 90-minute meeting). Create a dedicated Deepgram project and key, with a usage limit if available.
   - **GitHub token.** A fine-grained personal access token from github.com → Settings → Developer settings, limited to this one repository, with **Contents: Read and write** and an expiry date.
4. **Embed on eloyaz.gov.** In CivicPlus, add a Custom HTML widget and paste the contents of **`CivicPlus Embed Code.txt`** (top of this folder). This is the only code that goes into CivicPlus. Never paste files from `widget/` there; they only work on GitHub Pages.

   ```html
   <iframe src="https://city-of-eloy.github.io/city-council-widget/"
           title="City Council meeting summaries"
           style="width:100%; height:900px; border:0;" loading="lazy"></iframe>
   <script src="https://city-of-eloy.github.io/city-council-widget/embed.js" async></script>
   ```

   The script resizes the iframe to fit. If CivicPlus strips scripts, the iframe still works at the fixed height and scrolls inside. Add `?count=3` to the `src` to show fewer meetings, for example in a sidebar.

## Reviewing (twice a month, after each meeting)

Open **Eloy Council Summaries** → **Check for new meetings**. New Granicus recordings appear under **To review** with no summary yet. Test recordings are hidden automatically; other boards, duplicate recordings, and very short recordings get a yellow note.

1. Pick the meeting and click **Write summary with Claude**. The first time takes about 5 to 15 minutes: the app downloads the audio from Granicus, transcribes it, reads the posted agenda, and writes the summary. Leave the window open; **Cancel** stops it. Running it again on the same meeting ("Rewrite with Claude") reuses the saved transcript and takes a minute or two.
2. Read any yellow notes. Check the summary against the video and the posted agenda (links are under the fields). Edit the overview and full summary; the right side shows exactly how the summary will look on the website.
3. Click **Approve**, or **Hide** for recordings that shouldn't be published.

Then click **Publish to website**. The site updates within a few minutes. Editing or hiding an approved meeting and publishing again updates or removes it.

If two people review on different PCs, each **Check for new meetings** picks up what the other published. The app refuses to publish over changes it hasn't seen.

**Transcripts** are saved in `Documents\Eloy Minutes\Transcripts`, the same folder the City Clerk's **Eloy Minutes** app uses, with the same file names. A meeting transcribed by either app is reused by the other, so it is paid for once. **View transcript** (under the fields in the editor) shows it in the app with search; each timestamp opens the Granicus player at that moment. "Speaker N" labels in a transcript are automatic and do not identify people; Claude is told to name a Councilmember only when the transcript makes it clear, and to take item titles, numbers, and amounts from the agenda. Names in `review-app/resources/keyterms.txt` help Deepgram spell Council and staff names.

## How a summary is made

1. **Granicus listing.** `ViewPublisher.php?view_id=1` gives the name, date, length, agenda link, minutes link, and video link for every recording in the archive. The app lists all of them, so older meetings can be summarized too; the search box above the list finds one by date or name.
2. **Audio.** The bundled ffmpeg streams the recording from Granicus and keeps only a small mono MP3 (about 30 MB per hour). Granicus serves video only to browser-like requests, so the app sends a browser User-Agent and a Granicus Referer. A 90-minute meeting moves about 1 GB over the network.
3. **Transcript.** The MP3 goes to Deepgram (Nova-3, speaker separation) and is saved as `<date> <meeting> Transcript (clip N).txt`. If Granicus ever publishes captions for a clip, those are used instead and Deepgram is skipped.
4. **Agenda.** The posted agenda is read from Granicus (`AgendaViewer.php`). If there is none, the summary comes from the transcript alone and the app says so.
5. **Summary.** Claude writes the overview and the full summary at a sixth-grade reading level, spelling names from the Council roster on eloyaz.gov. The reviewer still checks it.

## Develop

```powershell
cd review-app
npm install                              # first time only; downloads ffmpeg (needs access to GitHub)
node node_modules\electron\install.js    # if npm held back Electron's download script
npm test                                 # offline engine checks with fixtures and a fake GitHub (no keys)
$env:SMOKE_LIVE = "1"; npm test          # adds live Granicus and roster checks
npm start                                # builds the screens and opens the app
npm run dist                             # builds release\Eloy Council Summaries Setup.exe

# End to end on the newest council meeting, through the same code path as the app (nothing is published):
$env:DEEPGRAM_API_KEY = "..."; $env:E2E_STAGE = "transcript"; npm run e2e     # transcript only
$env:ANTHROPIC_API_KEY = "sk-ant-..."; Remove-Item Env:E2E_STAGE; npm run e2e  # full summary
# $env:ELOY_CLIP_ID = "288" picks a clip; $env:E2E_RETRANSCRIBE = "1" ignores a saved transcript.
```

From VS Code's terminal, clear `ELECTRON_RUN_AS_NODE` before `npm start` (`$env:ELECTRON_RUN_AS_NODE = $null`). Otherwise Electron starts as plain Node and fails. `ELOY_USER_DATA=<folder>` keeps a test run away from the real review state and keys.

Optional environment overrides:

| Variable | Effect |
| --- | --- |
| `ELOY_AUDIO_BITRATE` | MP3 bitrate for the Deepgram upload (default `64k`) |
| `ELOY_CHUNK_AFTER_SEC` | Recordings longer than this are transcribed in one-hour parts (default 4 hours). Deepgram timeouts also fall back to parts. |
| `ELOY_KEEP_AUDIO` | `1` keeps the temporary MP3 in `%TEMP%\eloy-minutes` for troubleshooting |
| `FFMPEG_BIN` | Use a different ffmpeg.exe |

Widget preview:

```powershell
node tools\preview-widget.js            # http://localhost:5180/ with the real data file
node tools\preview-widget.js --sample   # with samples\meetings.sample.json
```

## Third-party components

The installer bundles an unmodified ffmpeg 6.1.1 build (from the `ffmpeg-static` npm package, gyan.dev "essentials" build), licensed under the GPL v3. Source: https://ffmpeg.org/download.html and https://www.gyan.dev/ffmpeg/builds/. The app runs it as a separate program.

## History

- **2026-10-13 (v2.0):** OpenPublica removed. Recordings and agendas come from Granicus, transcripts from Deepgram, summaries from Claude. Meetings published before this keep their place on the website; their ids change to the Granicus clip number (`granicus-287`) on the next publish.
- **2026-10-08 (v1.0):** First version, built from the City Clerk's minutes-drafting tool, with summaries from OpenPublica.
