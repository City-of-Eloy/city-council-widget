# Eloy City Council Summary Widget

A widget for the City of Eloy website (eloyaz.gov) that shows plain-language summaries of recent City Council meetings. Nothing reaches the website until a staff member reviews and approves it.

```
OpenPublica ──► Review app (staff PC) ──► GitHub: widget/data/meetings.json ──► GitHub Pages ──► iframe on eloyaz.gov
               review, edit, approve        commit triggers deploy
```

- **OpenPublica** already records and summarizes Eloy's meetings. Its API can't be called from a browser, so the review app fetches meetings and the widget only reads a static file of approved summaries.
- **Review app** (`review-app/`, Electron) pulls new meetings, auto-hides test and empty recordings, and flags meetings to check closely: duplicate recordings, commission meetings, incomplete recordings. The reviewer edits, optionally rewrites in plain language with Claude, approves, and publishes.
- **Widget** (`widget/`) is a static page: the latest meeting with an overview, a "Read the full summary" expander and a video link, then earlier meetings, plus a "not the official minutes" note.

## Folders

| Folder | What is in it |
| --- | --- |
| `widget/` | The website widget, deployed as-is to GitHub Pages. `data/meetings.json` holds the approved summaries and is written only by the review app. |
| `review-app/` | Staff review app. `main/engine/` holds the OpenPublica client, review workflow, GitHub publishing, and Claude rewrite. |
| `tools/preview-widget.js` | Previews the widget locally, optionally with sample data. |
| `samples/` | Unreviewed sample data for the local preview. Kept out of git (`.gitignore`), so it is never public. |
| `.github/workflows/pages.yml` | Deploys `widget/` to GitHub Pages on every change. |

## One-time setup

1. **Repository.** [`City-of-Eloy/city-council-widget`](https://github.com/City-of-Eloy/city-council-widget) is public. It contains no keys or tokens. Every version of the published summaries stays visible in its history, so review carefully before publishing. In Settings → Code security, turn on **Secret scanning** and **Push protection**. Commit with your GitHub "noreply" email address rather than a City address.
2. **Turn on Pages.** In the repository, open Settings → Pages and set Source to **GitHub Actions**. The widget is then served at `https://city-of-eloy.github.io/city-council-widget/`.
3. **Publishing token.** Create a fine-grained personal access token at github.com → Settings → Developer settings. Limit it to this one repository, with **Contents: Read and write**, and give it an expiry date. Paste it into the review app's Settings on each reviewer's PC. It is encrypted for that Windows account.
4. **Optional Claude key.** For the "Rewrite in plain language" button, paste an Anthropic API key in Settings. Use a dedicated Console workspace with a monthly spend limit. Each rewrite sends one meeting transcript to Claude Opus 5.5.
5. **Embed on eloyaz.gov.** In CivicPlus, add a Custom HTML widget and paste the contents of **`CivicPlus Embed Code.txt`** (top of this folder). This is the only code that goes into CivicPlus. Never paste files from `widget/` there; they only work on GitHub Pages.

   ```html
   <iframe src="https://city-of-eloy.github.io/city-council-widget/"
           title="City Council meeting summaries"
           style="width:100%; height:900px; border:0;" loading="lazy"></iframe>
   <script src="https://city-of-eloy.github.io/city-council-widget/embed.js" async></script>
   ```

   The script resizes the iframe to fit. If CivicPlus strips scripts, the iframe still works at the fixed height and scrolls inside. Add `?count=3` to the `src` to show fewer meetings, for example in a sidebar.

## Reviewing (twice a month, after each meeting)

Open **Eloy Council Summaries** → **Check for new meetings**. For each meeting under **To review**:

1. Read any yellow notes.
2. Edit the overview and full summary. The right side shows exactly how the summary will look on the website.
3. Click **Approve**, or **Hide** for meetings that shouldn't be published.

Then click **Publish to website**. The site updates within a few minutes. Editing or hiding an approved meeting and publishing again updates or removes it.

If two people review on different PCs, each **Check for new meetings** picks up what the other published. The app refuses to publish over changes it hasn't seen.

## Develop

```powershell
cd review-app
npm install
node node_modules\electron\install.js   # if npm held back Electron's download script
npm test                                 # engine checks with fake OpenPublica/GitHub (no keys needed)
npm start                                # builds the screens and opens the app
npm run dist                             # builds release\Eloy Council Summaries Setup.exe
```

From VS Code's terminal, clear `ELECTRON_RUN_AS_NODE` before `npm start` (`$env:ELECTRON_RUN_AS_NODE = $null`). Otherwise Electron starts as plain Node and fails.

Widget preview:

```powershell
node tools\preview-widget.js --refresh-sample   # rebuild samples\meetings.sample.json from OpenPublica
node tools\preview-widget.js --sample           # http://localhost:5180/
```

## Origin

Built from the City Clerk's minutes-drafting tool (OpenPublica client and Claude call pattern). The original tool is backed up at `Documents\City Clerk Minutes Automation (backup 2026-10-08).zip`.
