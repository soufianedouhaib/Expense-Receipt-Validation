# Expense Receipt Validation

Employee-facing web app for the Applied AI **Expense Receipt Validation** workflow in Opus.

An employee uploads a receipt, enters the total they're claiming and their details.
The backend sends all three to Opus, polls until the run finishes, and shows the
validation report. The browser never talks to Opus — only to this app's own routes.

---

## Before you start

Generate a **fresh** Opus service key (left menu → Run → API → Generate API Key).
The key is shown once. Do not reuse a key that has been pasted into chat, email or
a ticket.

## Local setup

```bash
npm install
cp .env.example .env      # then paste your new service key into .env
npm start                 # http://localhost:3000
```

`GET /api/health` reports any environment variable that's still missing.

## Deploy

```bash
git init
git remote add origin <your repo URL>
git add .
git commit -m "Initial version"
git push -u origin main
```

Then on vercel.com: Import Project → pick the repo → **add every variable from
`.env` under Settings → Environment Variables** → Deploy.

Vercel cannot see your local `.env`. A missing environment variable is the single
most common reason the app works locally and fails live. After that, every push to
`main` redeploys automatically.

---

## Workflow contract

Workflow: `305a53b2-a030-490d-b6fa-bd331c05c72a` — *Expense Receipt Validation* V7.1

**Inputs** (all required)

| Field | Variable ID | Type |
|---|---|---|
| Employee Record | `workflow_input_njojvf43i` | Text — JSON string |
| Receipt | `workflow_input_mgwnb0jd6` | File, single, ≤10MB |
| Submitted Total Expense Amount | `workflow_input_kf0w4zjdj` | Text — `"30 USD"` |

**Outputs**

| Field | Variable ID | Type |
|---|---|---|
| Expense Validation Summary Report | `workflow_output_mca30b5t9` | JSON string |
| Expense Receipt | `workflow_output_b5wjhtz1l` | File |
| Employee Record | `workflow_output_4lotpdmad` | Text |

The Employee Record JSON is assembled server-side in `buildEmployeeRecord()`:

```json
{
  "full_name": "...",
  "phone_number": "...",
  "date_of_birth": "YYYY-MM-DD",
  "gender": "MALE|FEMALE",
  "job_title": "...",
  "email": "...",
  "manager": { "name": "..." }
}
```

The summary report parses to:

```json
{
  "approved": true,
  "receipt_type": "Accommodation",
  "date": "2024-04-23",
  "extracted_total": { "amount": "30.00", "currency": "USD" },
  "submitted_total": { "amount": "30.00", "currency": "USD" },
  "amounts_match": true,
  "receipt_type_reasoning": "...",
  "amount_match_reasoning": "...",
  "summary": "..."
}
```

## Opus API calls used

Base `https://operator.opus.com/api/v1`, header `x-service-key`.

1. `POST /file/upload/presigned` → `{ presignedUrl, fileUrl }`
2. `PUT <presignedUrl>` — raw bytes, **no service key** (this goes to S3)
3. `POST /case` → `{ caseId }`
4. `POST /case/{caseId}/execute` — payload keyed by the `workflow_input_*` IDs
5. `GET /case/{caseId}/status` → `PENDING` · `IN_PROGRESS` · `WAITING` · `COMPLETED` · `FAILED` · `CANCELLED` · `TIMED_OUT`
6. `GET /case/{caseId}/results` → outputs keyed by `workflow_output_*`

The workflow has no human-review node, so there is no webhook route. If one is
added later, the webhook handler goes in `server.js` next to `/api/status`.

## Files

```
server.js          backend — holds the key, the only thing that talks to Opus
api/index.js       Vercel entry point (imports the exported Express app)
vercel.json        routes /api/* to api/index.js
public/index.html  the four screens: form, progress, result, failure
public/styles.css  design tokens, light and dark
public/app.js      form handling, upload, polling, result rendering
public/logo.png    Applied AI wordmark (transparent, inverts in dark mode)
.env.example       copy to .env; the same values go into Vercel by hand
```

## Notes

- Receipt limit is 10MB — Opus's cap, enforced in the browser and again in multer.
- Polling runs every 3s for up to 5 minutes, then tells the employee to check with HR
  rather than resubmitting and creating a duplicate case.
- Employee details are remembered in `localStorage` on the employee's own device only,
  and only while the "Remember my details" box is ticked.
- Colors live as CSS custom properties at the top of `styles.css`. To apply the
  AppliedAI UI Guidelines palette, change the tokens; nothing below them needs editing.

---

## Manager view

A second page at `/manager.html` lists every submission. It is gated by a shared
access code, and it needs storage — without Redis there is no history to show.

### Setup

1. **Vercel → Storage → Upstash Redis → Create.** Connect it to the project.
   Vercel writes `KV_REST_API_URL` and `KV_REST_API_TOKEN` into your environment
   variables automatically. (A direct Upstash project sets `UPSTASH_REDIS_REST_URL`
   and `UPSTASH_REDIS_REST_TOKEN` instead — the code accepts either.)
2. **Vercel → Storage → Blob → Create.** Connect it. This sets `BLOB_READ_WRITE_TOKEN`
   and is what lets managers open the actual receipt.
3. **Settings → Environment Variables** → add `MANAGER_ACCESS_CODE`. Any long random
   string. This is what managers type.
4. Redeploy.

For local work, copy all four values into `.env`.

`GET /api/health` reports which of the three are live:

```json
{ "ok": true, "history": true, "receiptArchive": true, "managerAccess": true }
```

### How it fits together

Each submission writes a record to Redis (`expense:case:<caseId>`, indexed by time
in `expense:index`) and a copy of the receipt to Blob. The employee's browser
updates the record as it polls. If they close the tab mid-run the record would sit
at "running" forever, so anything still running is re-checked against Opus whenever
a manager loads the list.

Receipts are never linked to directly. Blob URLs stay server-side; the manager's
"Open receipt" button hits `/api/manager/receipt/:caseId`, which checks the access
code and streams the file back.

### Manager routes

| Route | Purpose |
|---|---|
| `POST /api/manager/verify` | Checks the access code |
| `GET /api/manager/submissions` | The list, newest first, refreshing stale runs |
| `GET /api/manager/submissions/:caseId` | One submission in full |
| `GET /api/manager/receipt/:caseId` | Streams the archived receipt |
| `GET /api/manager/export.csv` | The list as CSV |

### What the access code is and isn't

It is one shared secret checked server-side on every manager request, held in
`sessionStorage` so it's gone when the tab closes. It keeps employees out of a page
listing their colleagues' names, emails and claim amounts.

It is not identity. Everyone shares one code, so you cannot tell who looked at what,
and rotating it means telling every manager the new one. If you need an audit trail
of who viewed which claim, that needs real per-person login — a different build.

### Data you are now storing

Adding this means you keep employee names, emails, job titles, phone numbers and
receipt images for a year (`RECORD_TTL_SECONDS` in `server.js`). That is personal
data in a second place beyond Opus. Worth a word with whoever owns data retention
at AAICO before this goes to the whole company.
