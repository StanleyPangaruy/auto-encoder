# Bookkeeping encoders

Turns scanned tax documents into Excel workbooks for a bookkeeper's clients. Two encoders:

- **Purchases** — supplier invoices, receipts and bills into a purchases summary (input VAT).
- **BIR 2307** — certificates of creditable tax withheld into a list of payors and tax withheld.

## Where things are

```
raw/<Client>/...            source scans, exactly as received (never edited)
raw/zips/                   the original downloads
output/<Client>/...         the workbooks; each folder has a backup/ of earlier versions
output/trials/              model comparisons and partial runs, safe to delete
clients/<name>.json         one client's settings
clients/<name>.suppliers.csv  that client's supplier list (purchases)
inbox/                      drop folder watched by n8n (CYA purchases)
data/                       saved model answers, so nothing is paid for twice
engine/                     the engine: reading, row rules, workbooks, database (used by cli/ and the app)
cli/                        command-line entry points
scripts/, test/             maintenance scripts and tests
n8n/                        local n8n install and its workflow
```

| Client | Raw | Output | Settings |
|---|---|---|---|
| CYA Electrical Supply Retail Corp (TIN 010-786-993) | `raw/CYA/2026-07` to `2026-10` | `output/CYA/PURCHASES 2026.xlsx` | `config.json` (the defaults), Sonnet 5.5 |
| JJEL Meycauayan Sukimart Inc (TIN 651-245-228) | `raw/JJEL Sukimart/Sept 2026` | `output/JJEL Sukimart/PURCHASES 2026.xlsx` | `clients/jjel-sukimart.json`, Haiku 5.5 |
| Tayan Electrical (TIN 175-007-254) | `raw/Tayan/Tayan (1).pdf` | `output/Tayan/2307/Tayan_encoded.xlsx` | `clients/tayan.json`, Haiku 5.5 |

The user renamed Tayan's workbook to `Tayan_encoded.xlsx`. A re-run writes `Tayan (1).xlsx` beside it
(the workbook is named after the PDF) and does not touch the renamed file.

## Commands

```
node cli/purchases.js --in "raw/CYA/2026-09" --keep                                  purchases, CYA
node cli/purchases.js --client jjel-sukimart --in "raw/JJEL Sukimart/Sept 2026" --keep  purchases, another client
node cli/bir2307.js --client tayan --in "raw/Tayan/Tayan (1).pdf" [--pages 1-8]  BIR 2307
node scripts/check-testfiles.js [folder]      compare readings with answers in CYA's file names
node scripts/show-2307.js "<workbook>" [--flagged]
npm test                                      offline tests, no API calls
```

`--keep` leaves the source files in place. Without it (the n8n inbox flow) they move to `<folder>/processed`.
`ENCODER_MODEL=claude-haiku-5-5` in front of a command tries another model without changing settings.
The API key is in `.env`. Every file's answer is cached, so re-running a folder is free and adds nothing.

## Rules that apply everywhere (confirmed by the user)

- **Never guess.** A field that is present but illegible stays blank and the row is marked
  `FOR MANUAL CHECKING: <reason>` in REMARKS and shaded. A field that is not on the document stays blank, unmarked.
- **The workbook is the record.** A run reads the existing sheet back first, so corrections typed in Excel
  survive, and copies the previous file to `backup/` before writing. A run that adds nothing writes nothing.
- The user's column layouts are the spec. Extra columns (REMARKS, SOURCE FILE / PAGE) go to the right only.
- These figures go into tax filings. When a change affects amounts, TINs or dates, check it against real scans.
- Raw scans and outputs hold tax data; `.gitignore` keeps them out of any repo.

## Purchases encoder

`engine/extract.js` (prompt, schema, image preparation, cache) -> `engine/rows.js` (row rules, duplicates) ->
`engine/workbook.js` (sheet layout), run by `engine/purchases.js`, with `cli/purchases.js` as the command line
and `engine/suppliers.js` for the supplier list.

Sheet: totals in row 1 (yellow, `TOTAL` in PARTICULARS), header in row 2, data from row 3.

| Column | Rule |
|---|---|
| SN | Running number per sheet |
| MONTH / DATE | 3-letter month and 2-digit day (text) of the document's own date |
| SI/OR | Document number without prefix or leading zeros. Blank when there is none |
| TIN | Supplier TIN, first 9 digits, text |
| COMPANY NAME | Supplier registered name, uppercase |
| LAST / FIRST / MIDDLE | Only for individual suppliers |
| ADDRESS / CITY | See address styles below |
| NATURE | `GOODS` or `SERVICES`, from PARTICULARS |
| PARTICULARS | `INVENTORY`, `OFFICE SUPPLIES`, `FUEL AND OIL` (goods); `UTILITIES EXPENSE`, `REPRESENTATION EXPENSE` (services) |
| AMOUNT | Total amount due, VAT inclusive. A crossed-out total is replaced by the figure written beside it |
| NET OF VAT / INPUT VAT | Formulas: `ROUND(AMOUNT/1.12,2)` and `AMOUNT - NET` |
| NON VAT | Never filled automatically |
| CHECKING | Formula `AMOUNT - NET - INPUT VAT - NON VAT`, red |

- Non-VAT, VAT-exempt or unclear documents: AMOUNT is encoded, the three VAT cells stay blank, row marked.
- Utility bills are treated as fully VAT inclusive.
- Delivery receipts are kept only while no invoice with the same supplier and amount exists.
- Duplicates: a document number already in the sheet for the same supplier (matched by TIN **or** name) is skipped.
- A date more than a year from today is treated as a misread and the row is left undated.
- Supplier list: gains a line per new TIN; its values override what is read; a supplier already listed
  under the same name keeps its listed TIN.
- Pages that are not purchase documents (the client's own sales ledger) are reported and not encoded.
- A long invoice over several pages is one row; pages with different invoice numbers are separate rows.

Per-client options in `clients/<name>.json`:

- `layout` — default: one sheet per month, sorted by day then number, undated rows on `UNDATED` (CYA).
  `"file-order"`: one sheet per input folder, named after it, rows in File Explorer name order, never
  sorted or regrouped (JJEL). Do not rename a file-order client's raw folder: the sheet is named after it.
- `addressStyle` — default: ADDRESS is the district, CITY the city or province (CYA).
  `"full"`: ADDRESS is the whole address without its last part, CITY is that last part (province outside
  Metro Manila, city inside), no punctuation (JJEL).
- `buyerName`, `buyerTin`, `model`, `output`, `suppliersFile`, `inventoryHint`.

Open point: some Anglinco invoices (CYA) carry a pencilled figure beside the withholding-tax line that the
user's file names use instead of Total Amount Due (377409, 377416). The encoder uses Total Amount Due.
The user has not yet said which to encode.

## BIR 2307 encoder

`engine/bir2307.js` (reads pages, builds rows) -> `engine/workbook2307.js`, run by `engine/certificates.js`,
command line `cli/bir2307.js`.

- Columns: NO., MONTH, YR (left blank by the user's choice), TIN, COMPANY, LN, FN, MN, ADDRESS, CITY, AMOUNT,
  ATC, RATE, WTAX, then REMARKS and PAGE. The encoded party is the **payor** (Part II).
- Rows stay in PDF page order. Never sort or group them.
- One row per ATC line per month that has an amount. MONTH is the quarter of the period plus the column
  the amount sits in. When only the Total is filled and the period is one month, that month is used.
- Rate when not printed: WC158/WI158/WC156/WI156 = 1%, WC160/WI160/WC157/WI157 = 2%.
- Each page is sent as its full-resolution scan plus an enlarged copy of the top 45%, because the boxed
  period and TIN digits are small. Without the enlargement, periods and TINs were misread.
- Marked for manual checking when: tax withheld is not amount x rate; months do not add up to the total;
  the amount is not in the column for the period's month; the same company has different TINs on different
  pages; the payee is not the client; an unreadable field.

## What has been measured (2026-10-10)

- CYA September, 49 files with answers in their names: Sonnet 0 wrong amounts, Haiku 5 wrong (handwritten
  Anglinco invoices). The user chose Sonnet for CYA. About 1.3 cents a document.
- Tayan 2307, 247 pages on Haiku: $0.37, 255 rows, 103 marked. Sonnet at high effort costs about 2 cents a
  page and reads the boxed TINs better.
- JJEL Sept 2026, 125 PDFs / 282 pages on Haiku: 293 rows, 108 marked. Its scans are low-quality black and
  white; spot checks found unflagged misreads (a date and a TIN on Advect 10430/10431). No file-name
  answers exist for this client, so accuracy there is not measured.
- A local model through Ollama was tried and removed at the user's request (4 GB GPU, too slow).

## n8n

`start-n8n.cmd` starts the local n8n (http://localhost:5678) with the Execute Command node enabled
(`NODES_EXCLUDE=[]`; n8n 2.x disables it by default) and its database in `n8n/data/`. The imported workflow
`purchaseEncoder01` runs `node cli/purchases.js --json` on `inbox/` every 10 minutes or on demand, for CYA only.

## When changing the code

- Delete the matching folder under `data/` after changing a prompt or schema, or old answers are reused.
- The workbook cannot be written while it is open in Excel; the run stops with a message and loses nothing.
- Test file names with amounts (`Kcei 2026-09-01 SI-9001 846.03`) have no real extension; files are
  identified by their content, not their name.

## Receipt bundles and second readings (purchases)

```
node cli/purchases.js --client jjel-sukimart --in "raw/JJEL Sukimart/JJEL MEYCAUAYAN SUKIMART RECEIPTS.pdf" \
     --by-page --second-pass claude-sonnet-5-5 --sheet RECEIPTS --keep
```

- `--in` may name one file. `--sheet` names the sheet for a file-order client.
- `--by-page` reads each PDF page on its own: for bundles of till receipts scanned two to a page. Each
  page is sent as the whole page plus its left and right halves enlarged (`engine/pdfpages.js` recovers
  black-and-white fax-compressed scans at full resolution). Without it a PDF is read whole, which is
  right for multi-page invoices.
- `--second-pass <model>` re-reads with a stronger model any page (or whole file) whose first reading
  left the reading itself in doubt: unreadable fields, compare-with-paper, missing date or amount, VAT
  that does not match. Decisions left to the user (non-VAT, particulars not set) do not trigger it.
- A document made out to someone other than the client is still encoded, marked
  `MADE OUT TO <name>, NOT THE CLIENT`. The user decides whether it belongs.
- REPRESENTATION EXPENSE is restaurants and other food receipts only (user's rule).
- `node scripts/forget-pages.js --client <name> "<file.pdf>" 33-44` drops saved readings of those pages.
- `node scripts/show-purchases.js "<workbook>" "<sheet>" [--flagged]` prints a sheet for spot checks.

JJEL receipts bundle (2026-10-13): 44 pages, 86 rows, 31 pages given a second reading by Sonnet.

## 2307 second reading (2026-11-16)

```
node cli/bir2307.js --client tayan --in "raw/Tayan/Tai-An Sales 2307 October 2026 (1).pdf" --second-pass claude-sonnet-5-5
```

- `--second-pass <model>` re-reads with that model every page whose first reading left the reading in
  doubt (unreadable fields, TIN differs between pages, month column vs period, months not adding up,
  unrecognised ATC, missing amount). How the payor filled in the form (tax not equal to rate x amount,
  payee not the client) does not trigger it.
- Also marked: an ATC that is not a real code (for example `ATC158`), and the same payor, month and
  amount on two pages (possible duplicate certificate).
- Tai-An Electrical and Industrial Components OPC (TIN 811-331-813) is a separate company from Tayan.
  Its PDF sits in `raw/Tayan` and its workbook in `output/Tayan/2307` until the user decides whether it
  gets its own client folder.
- Tai-An October 2026: 29 pages, Haiku then Sonnet on 13 pages, about $0.30, 9 rows left marked.

## Engine and database (app step 1, 2026-11-16)

The code is being turned into a local web app for one bookkeeper (the user's girlfriend), run on her PC
in the browser. Planned stack: Node 24, Fastify server bound to 127.0.0.1, SQLite through `node:sqlite`,
React + TypeScript + Vite with Mantine, TanStack Query, React Router. Step 1 (this) restructured the
engine; next are the Clients and Encode screens, then the review screen, then export and a desktop shortcut.

- `engine/settings.js`: `loadSettings({ client, model })` returns one client's settings. Nothing in the
  engine reads global settings or command-line flags any more, so one server can serve every client.
- `engine/purchases.js` and `engine/certificates.js` are the jobs (`readPurchases`, `buildPurchaseRows`,
  `savePurchaseWorkbooks`; `encodeCertificates`). They report progress and every paid call's cost
  through callbacks.
- `engine/db.js`: the database, `data/app.db` (ignored by git; copying it is a backup). Tables: clients,
  jobs, rows (row fields as JSON plus sheet, position, source file and page, checked), usage (cost per
  call), app_settings. Schema changes go in as new entries at the end of `MIGRATIONS`.
- The command-line runs record each job, its rows and its cost in the database. Trial runs (`--out`,
  `--pages`) are not recorded. A 2307 PDF encoded again replaces its earlier job.
- `npm run import-db` (`scripts/import-to-db.js`) loads the current workbooks into the database,
  including corrections typed in Excel. Safe to repeat.
- Until the app exists, the workbooks remain what the user works in; the database is kept alongside.

Checked on 2026-11-16 by regenerating every client's workbooks from saved readings and comparing cell by
cell: identical apart from changes explained by later improvements (supplier list knowledge, newer
2307 checks) and one source file the user renamed.

## The app (step 2, 2026-11-16)

`start-app.cmd` (or `npm run app`) starts the server on http://localhost:3000, listening on this PC only,
and opens the browser. `npm run build-web` rebuilds the screens after changing `web/`; for live editing run
`npm run dev --prefix web` (port 5173, API calls go to the server on 3000).

- `server/index.js`: Fastify routes: clients, sources (folders and PDFs already in raw/<client>), uploads
  (into raw/<client>/<batch>/, or raw/<client>/ for a 2307 PDF; never overwrites, names are kept inside
  the client folder), jobs, job progress as Server-Sent Events, second pass, costs, and opening a workbook
  in Excel (only files under output/).
- `server/clients.js`: the Clients screen edits the settings files (config.json for CYA,
  clients/<id>.json for others). New clients get output/<folder>, raw/<folder> and their own supplier list.
- `server/jobs.js`: one job at a time. The first reading uses the client's model; if anything was left in
  doubt the job finishes with an offer to re-read it with Sonnet (estimate shown), which runs only when the
  user presses the button (user's rule: ask before Sonnet). No offer for clients that already use Sonnet.
- A purchases re-read replaces that job's rows in the workbook (the screen says so; the workbook is backed
  up). A 2307 job never overwrites an existing workbook: a new run writes "<pdf> (2).xlsx" and so on.
- Jobs cut off by closing the app are marked failed at the next start; re-running costs nothing for
  documents already read.
- `web/`: React + TypeScript + Mantine 8 + TanStack Query 5 + React Router 7, built with Vite 7 into
  web/dist (ignored by git). Screens: Encode, Jobs, Job (progress, results, re-read offer), Clients.
- Rows in the database belong to the workbook they are in (`engine/record.js` syncs a workbook after each
  job). Jobs keep a summary, including a short list of the rows they added.

## Review screen (step 3, 2026-11-16)

The Review page shows a sheet's rows (those to check first), the scan each row came from, and the row's
fields. Ctrl+S saves; Ctrl+Enter saves, clears the FOR MANUAL CHECKING remark (and so the shading) and
moves to the next row to check.

- Saving edits the row in the database, then rewrites the workbook from the database
  (`engine/record.js` writeFromSnapshot). Reading a workbook into the database and writing it back gives an
  identical file (checked on CYA, JJEL and Tai-An), so only edited rows change.
- Before every save the app checks the workbook's modified time. If it changed (edited in Excel), the
  workbook is read in again and the save is refused with a message; nothing typed in Excel is overwritten.
  Opening a sheet re-reads a changed workbook too.
- Backups during review: at most one per hour per workbook (`engine/savefile.js`, backupEvery).
- Month-sheet clients: changing a row's month moves it to that month's sheet (or UNDATED) in date order.
- Row ids are never reused (rows table uses AUTOINCREMENT, schema version 3): a screen holding a stale id
  after a re-read gets "row no longer exists" instead of editing a different row.
- Scans: `engine/scans.js` finds a purchases row's file by name under raw/<client> (two levels deep) and
  page; a 2307 workbook's PDF is the one the user chose, the one its job recorded, or the same name.
  Pages that are plain scans are served as JPEGs (cached in data/scans); other PDF pages are sent as a
  one-page PDF and drawn in the browser with pdf.js 4. `Tayan_encoded.xlsx` needs its PDF chosen once
  (Tayan (1).pdf).
