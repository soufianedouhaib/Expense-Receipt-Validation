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

## Signing in

Everyone signs in with their Google Workspace account. No passwords are stored
by this app, and the name and email on a claim come from the verified session
rather than from anything typed into the form.

### Roles

| Role | Who gets it | What they see |
|---|---|---|
| Employee | anyone in the allowed domain | Submit a claim |
| Manager | listed in `MANAGER_EMAILS` | Claims that name them as manager |
| Admin | listed in `ADMIN_EMAILS` | Every claim, plus CSV export |

Roles stack. An admin who is also in `MANAGER_EMAILS` sees both doors on the
welcome page and can switch between them.

Manager scoping matches on the manager email the employee entered, falling back
to a name match. The email is the reliable one — two people with the same name
would otherwise see each other's team. Every request is re-checked server-side,
so the role picked on the welcome page changes the view, never the permissions.

### Google Cloud setup

1. [console.cloud.google.com](https://console.cloud.google.com) → your project
2. **APIs & Services → OAuth consent screen** → Internal (keeps it to your
   Workspace) → fill in the app name and support email
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   → Application type **Web application**
4. Under **Authorised redirect URIs** add exactly:

   ```
   https://<your-project>.vercel.app/api/auth/callback
   ```

   This must match `APP_URL` + `/api/auth/callback` character for character,
   including https and no trailing slash. A mismatch is the single most common
   sign-in failure, and Google's error names the URI it expected.

5. Copy the **Client ID** and **Client secret**

### Environment variables

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 5 |
| `GOOGLE_CLIENT_SECRET` | from step 5 |
| `APP_URL` | `https://<your-project>.vercel.app`, no trailing slash |
| `ALLOWED_EMAIL_DOMAIN` | `aaico.com` |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `ADMIN_EMAILS` | comma-separated |
| `MANAGER_EMAILS` | comma-separated |

Tick Production, Preview and Development, then **redeploy** — environment
changes never reach a build that already exists.

`MANAGER_ACCESS_CODE` is no longer used and can be deleted.

### Pages

```
/                welcome — sign in, then choose a role
/submit.html     employee: file a claim
/workspace.html  manager or admin: review claims
```

Each page asks `/api/me` before rendering and sends a signed-out visitor back to
the welcome page. That is a convenience, not the boundary: the boundary is that
every API route checks the session cookie and the role itself.

### Sessions

A signed cookie, HttpOnly and Secure, valid for 12 hours. Sign out clears it and
returns to the welcome page. The cookie carries only identity and roles — no
tokens, nothing that can be replayed against Google.

---

## Storage

The manager and admin views need history, which lives in Redis.

1. **Vercel → Storage → Redis → Create → Connect to Project.** The code accepts
   either the REST credentials or a plain `REDIS_URL`, whichever the integration
   provides, with or without a name prefix.
2. **Vercel → Storage → Blob → Create → Connect to Project.** Sets
   `BLOB_READ_WRITE_TOKEN`, which is what lets reviewers open the receipt file.
3. **Redeploy.** Connecting a store adds variables but does not rebuild what is
   already running — this is the usual reason storage looks connected and
   nothing is saved.

`GET /api/health` reports the state of all of it:

```json
{ "ok": true, "history": true, "storage": "tcp",
  "receiptArchive": true, "signIn": true, "domain": "aaico.com",
  "admins": 1, "managers": 2 }
```

### How it fits together

Each submission writes a record to Redis (`expense:case:<caseId>`, indexed by
time in `expense:index`) and a copy of the receipt to Blob. The employee's
browser updates the record as it polls. If they close the tab mid-run the record
would sit at "running" forever, so anything still running is re-checked against
Opus whenever a reviewer loads the list.

Receipts are never linked to directly. Blob URLs stay server-side; the "Open
receipt" button hits `/api/manager/receipt/:caseId`, which checks the session and
the scope before streaming the file back.

### Routes

| Route | Who |
|---|---|
| `GET /api/auth/google`, `GET /api/auth/callback` | anyone |
| `POST /api/auth/logout`, `GET /api/me` | anyone |
| `POST /api/submit`, `GET /api/status/:caseId` | signed in |
| `GET /api/manager/submissions` | manager or admin, scoped |
| `GET /api/manager/submissions/:caseId` | manager or admin, scoped |
| `GET /api/manager/receipt/:caseId` | manager or admin, scoped |
| `GET /api/manager/export.csv` | admin only |

### Data you are storing

Employee names, emails, job titles, phone numbers and receipt images are kept for
a year (`RECORD_TTL_SECONDS` in `server.js`). That is personal data in a second
place beyond Opus. Worth a word with whoever owns data retention at AAICO before
this goes to the whole company.
