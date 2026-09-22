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
server.js             backend — holds the key, the only thing that talks to Opus
api/index.js          Vercel entry point (imports the exported Express app)
vercel.json           routes /api/* to api/index.js, the rest to public/
lib/auth.js           sessions, password hashing, role checks
package.json          dependencies and the start script

public/index.html     sign-in and the demo accounts
public/welcome.js     sign-in behaviour
public/submit.html    submit a claim: form, progress, result, failure
public/app.js         form handling, upload, polling, result rendering
public/workspace.html my claims / team claims / all claims
public/workspace.js   the claims list, filters, totals and the detail panel
public/report.html    the report: pinned ribbon plus five chapters
public/report.js      report figures, charts and animation
public/settings.html  connection and storage status
public/settings.js    settings behaviour
public/nav.js         the hover-expanding side rail, built from your roles
public/support.js     the Contact Opus support mail link
public/duration.js    one duration formatter, shared by the three pages
                      that show a time to decision
public/styles.css     design tokens, light and dark, and every component
public/logo.png       Applied AI wordmark (transparent, inverts in dark mode)
public/samples/*.pdf  the four sample receipts behind the scenario buttons

.env.example          copy to .env; the same values go into Vercel by hand
```

Every page loads `styles.css`, then `nav.js`, then its own script. The three that
print a duration load `duration.js` in between: drop it and they render no
timings at all.

## Notes

- Receipt limit is 10MB — Opus's cap, enforced in the browser and again in multer.
- Polling runs every 1s for the first minute, then every 3s, for up to 5 minutes
  total, after which it tells the employee to check with HR rather than resubmitting
  and creating a duplicate case. The fast opening minute is deliberate: the decision
  clock stops when the server first *sees* a run finish, so the poll gap is the error
  bar on every duration the app prints, and most runs land inside that minute.
- A run observed more than 5 minutes after it started is recorded as **not timed**
  rather than given a number. Closing the tab mid-run and reopening the page an hour
  later would otherwise write "1h 04m" into the record as if it were a measurement.
  Untimed claims show no duration anywhere, and the report's average says how many
  claims it covers so the count can be compared against the claim count beside it.
- Employee details are remembered in `localStorage` on the employee's own device only,
  and only while the "Remember my details" box is ticked.
- Colors live as CSS custom properties at the top of `styles.css`. To apply the
  AppliedAI UI Guidelines palette, change the tokens; nothing below them needs editing.

---

## Signing in — demo accounts

Seven demo accounts are built into `lib/auth.js` with scrypt-hashed passwords.
Nothing to configure: deploy and sign in.

| Role | Email | Name |
|---|---|---|
| Employee | mahmoud@demo.aaico.com | Mahmoud Sharshira |
| Employee | layla@demo.aaico.com | Layla Haddad |
| Employee | karim@demo.aaico.com | Karim Nasser |
| Employee | noor@demo.aaico.com | Noor Abdallah |
| Manager | omar@demo.aaico.com | Omar Busaileh |
| Manager | sara@demo.aaico.com | Sara Khalil |
| Admin | admin@demo.aaico.com | Portal Admin |

Passwords were generated when the accounts were created and are not recorded in
this repository — only their hashes are. To change one, generate a fresh salt and
scrypt hash (N=16384, r=8, p=1, keylen=64) and replace the pair in `lib/auth.js`.

Mahmoud and Layla report to Omar Busaileh; Karim and Noor to Sara Khalil. The
Manager field on the form is prefilled accordingly, which is what routes each
claim to the right reviewer.

### This is a demo mechanism, not a security boundary

- Accounts and hashes live in the repository.
- Anyone with the address and a password can sign in.
- `SESSION_SECRET` falls back to a value in the source when unset, so on a
  default deployment session cookies are forgeable by anyone who reads the file.

Set `SESSION_SECRET` in Vercel to close that last one. Replace the accounts with
a real identity provider before anything that matters goes through it — the
session, role and scope machinery around them does not change.

### Roles

| Role | How you get it | What you see |
|---|---|---|
| Employee | every account | Submit a claim · My claims |
| Manager | the account says so, **or** somebody names you on a claim | My team |
| Admin | the account says so, or `ADMIN_EMAILS` lists you | All claims |

Manager matching folds case and collapses spaces, so `Omar  BUSAILEH` finds
`omar busaileh`. It is a name match: the name on the form has to match the
manager's account name, and two people sharing a name would see each other's
team.

### Pages

```
/                            sign in, then pick a door
/submit.html                 file a claim
/workspace.html?scope=mine   your own claims
/workspace.html?scope=team   claims naming you as manager
/workspace.html?scope=all    every claim (admin)
```

One workspace page serves all three scopes. Asking for a scope you do not hold
falls back to `mine`, and the server re-checks every request — the URL changes
the view, never the permissions.

---

## Storage

History lives in Redis, and every list view depends on it.

1. **Vercel → Storage → Redis → Create → Connect to Project.** The code accepts
   either REST credentials or a plain `REDIS_URL`, with or without a prefix.
2. **Vercel → Storage → Blob → Create → Connect to Project.** Sets
   `BLOB_READ_WRITE_TOKEN`, which is what lets anyone open the receipt file.
3. **Redeploy.** Connecting a store adds variables but does not rebuild what is
   already running.

`GET /api/health`:

```json
{ "ok": true, "history": true, "storage": "tcp", "receiptArchive": true,
  "signIn": true, "demoAccounts": 7, "sessionSecretIsDefault": true }
```

### Keys

| Key | Holds |
|---|---|
| `expense:case:<caseId>` | the claim record |
| `expense:index` | every claim, newest first |
| `expense:emp:<email>` | one person's own claims |
| `expense:mgr:<name>` | claims naming that manager |
| `expense:managers` | every name ever given as a manager |

### Routes

| Route | Who |
|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me` | anyone |
| `POST /api/submit`, `GET /api/status/:caseId` | signed in |
| `GET /api/claims?scope=` | signed in, scope enforced |
| `GET /api/claims/:caseId` | own, managed, or admin |
| `GET /api/claims/:caseId/receipt` | own, managed, or admin |
| `GET /api/claims.csv?scope=` | same rules as the list |

A claim you may not see returns 404, not 403 — the response never confirms that
someone else's claim exists.

### Data you are storing

Names, emails, job titles, phone numbers and receipt images are kept for a year
(`RECORD_TTL_SECONDS` in `server.js`).
