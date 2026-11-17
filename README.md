# Auto-Encoder

Turns scanned tax documents into Excel workbooks for a bookkeeper's clients:

- **Purchases**: supplier invoices, receipts and bills go into a purchases summary (input VAT).
- **BIR 2307**: certificates of creditable tax withheld go into a list of payors and tax withheld.

It runs as a local web app on one Windows PC, at http://localhost:3000. Only that PC can open it.
Claude (Anthropic's API) reads the scans, so the app needs an Anthropic API key and an internet connection.

## Setting it up on a new computer

### 1. Install the tools

- **Node.js 24** (LTS) from https://nodejs.org. The Windows installer with default options is enough.
- **Git** from https://git-scm.com, or download the repository as a ZIP from GitHub instead.
- **Microsoft Excel**, to open the workbooks.

To check that Node is installed, open a new PowerShell window and run:

```bash
node -v
```

It should print `v24` followed by more digits.

### 2. Get the code

```bash
git clone https://github.com/StanleyPangaruy/auto-encoder.git
```

Put it somewhere permanent, for example `C:\Users\<you>\auto-encoder`. The desktop shortcut points to this folder,
so if you move the folder later, create the shortcut again (step 6).

### 3. Install the app

In PowerShell, inside the `auto-encoder` folder:

```bash
npm ci
```

```bash
npm ci --prefix web
```

```bash
npm run build-web
```

```bash
npm test
```

The last command checks the install. All tests should pass. They make no API calls and cost nothing.

npm may warn that `sharp` and `esbuild` have install scripts it did not run. Both work without them, so you can
ignore the warning.

### 4. Copy the client files from the old computer

The client documents and tax data are kept out of git on purpose, so a fresh copy of the code has none of them.
**Close the app on the old computer first** (the Quit button), then copy these folders and files across into the same
places in the new `auto-encoder` folder:

| What | Why it matters |
|---|---|
| `raw/` | The source scans, exactly as received |
| `output/` | The workbooks, including their `backup/` folders |
| `data/` | The database (`app.db`), saved model answers (so nothing is paid for twice) and cached scan images |
| `clients/*.suppliers.csv` | Each client's supplier list |
| `.env` | The API key (optional: you can enter it again in Settings instead) |
| `inbox/`, `n8n/data/` | Only if you use the n8n automation |

The settings files (`config.json` and `clients/*.json`) are already in git.

These files contain clients' tax data. Move them with a USB drive or a private cloud folder, not a public link.

If you copied `output/` but **not** `data/`, rebuild the database from the workbooks:

```bash
npm run import-db
```

### 5. Start the app and add the API key

```bash
start-app.cmd
```

The browser opens at http://localhost:3000. If the screen says **No Anthropic API key**, open **Settings** and
paste the key (from https://console.anthropic.com). The app checks the key with Anthropic before it saves it.

### 6. Create the desktop shortcut

```bash
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
```

This adds **Auto-Encoder** to the desktop and the Start menu. From then on, use the shortcut to open the app.

## Everyday use

- **Open:** double-click **Auto-Encoder**. The app starts with no window and opens in the browser. If it is
  already running, the shortcut only opens the browser.
- **Close:** use the **Quit** button in the app's header.
- **Encode:** choose the client and the kind of document, then add the scans. If some readings are left in doubt,
  the app offers to re-read them with Sonnet and shows the cost first. Nothing is re-read until you press the button.
- **Review:** the Review page shows each row beside its scan. Ctrl+S saves. Ctrl+Enter saves, clears the
  FOR MANUAL CHECKING remark and moves to the next row to check.
- **Excel:** you can still correct the workbooks in Excel. The app reads your changes back and never overwrites
  them. Close a workbook in Excel before encoding into it.

## When something goes wrong

| Problem | What to do |
|---|---|
| The shortcut does nothing, or a log file opens | Read `data\logs\app.log`. Run `start-app.cmd` to see the messages in a window. |
| `start-app.cmd` stops with an `EADDRINUSE` error | The app is already running (from the shortcut). Open http://localhost:3000, or use Quit and start it again. |
| "… is open in Excel. Close it and try again" | Close the workbook in Excel and run again. Nothing is lost. |
| The screens look out of date after updating the code | Run `npm run build-web`. |

## Updating to a newer version

```bash
git pull
```

```bash
npm ci
```

```bash
npm ci --prefix web
```

```bash
npm run build-web
```

Quit the app before updating, and start it again afterwards.

## Backups

Copy these to a USB drive or a private cloud folder from time to time: `output/`, `data/app.db`, `raw/` and
`clients/*.suppliers.csv`. Each workbook folder also keeps earlier versions in its own `backup/` folder.

## For developers

`CLAUDE.md` describes the code, the encoding rules and the command-line tools. For live editing of the screens, run
`npm run dev --prefix web` (port 5173) next to the server.
