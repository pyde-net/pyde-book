# AWS Amplify Hosting — runbook

The book deploys to AWS Amplify Hosting. Amplify owns the build
runner, the storage, the CDN, and the certificate. Push to `main`,
Amplify rebuilds and rolls out automatically.

DNS stays at Namecheap; we add one CNAME there pointing at Amplify's
CDN target plus one validation CNAME for ACM.

```
GitHub push ──► Amplify (build runner)
                     │ runs mdbook build → book/
                     ▼
              Amplify CDN
                     │
        ▲────────────┘
        │
Namecheap DNS (CNAME for book.pyde.network + ACM validation)
```

The marketing site at `pyde.network` is a separate Amplify app — see
`pyde-net/website/docs/AMPLIFY_DEPLOYMENT.md`.

---

## 1 · Connect the repo

1. Console → **Amplify** → **Create new app** → **Host web app**.
2. Source: **GitHub**. Authorise Amplify on `pyde-net/pyde-book`
   (one-time per repo).
3. Pick repo `pyde-net/pyde-book`, branch `main`. Next.
4. **App name**: `pyde-book`. Amplify auto-detects `amplify.yml` and
   shows the build preview: download mdBook → `mdbook build` →
   artifacts in `book/`. Confirm. Next.
5. Review → **Save and deploy**.

First build runs immediately (~30 s — mdBook is fast). When green,
Amplify gives you a temporary URL like
`https://main.d2hijklm.amplifyapp.com` — open to verify.

---

## 2 · Wire the custom domain

### 2.1 · Add the subdomain in Amplify

1. App page → left sidebar → **App settings** → **Domain management**.
2. **Add domain**. Enter `pyde.network`. Configure.
3. **Subdomain setup**: delete the default root + www slots, add a
   single entry:
   - Subdomain `book` → branch `main`.
4. Save.

Amplify shows a **Configure DNS** panel with two records.

### 2.2 · Paste records at Namecheap

1. Namecheap → Domain List → **Manage** → **Advanced DNS** tab.
2. **Add new record** twice:

| Amplify gives you… | Namecheap field |
|---|---|
| `_xxxxxxxxxxxxxxxx.book.pyde.network` → `_yyyyyyyyyyy.acm-validations.aws` | Type **CNAME**, Host `_xxxxxxxxxxxxxxxx.book` (everything before `.pyde.network`), Value the `_yyy...aws` target |
| `book.pyde.network` → `dXXXX.cloudfront.net` | Type **CNAME**, Host `book`, Value the `dXXXX.cloudfront.net` target |

3. Save each.

### 2.3 · Wait for Amplify

Status moves Verifying ownership → Issuing certificate → Available.
~5 min if DNS propagated quickly. Browse `https://book.pyde.network`
once status reads **Available**.

---

## 3 · Day-2 ops

- **Push to `main`** → auto-rebuild.
- **Edit a chapter**: `mdbook serve --open` locally for live
  preview, then push.
- **Rollback**: pick a previous deploy in the build history →
  **Redeploy this version**.
- **Build logs**: every build keeps the full mdBook trace.

---

## 4 · Cost ballpark

- Build minutes: free tier covers all realistic usage.
- Hosting: $0.023 / GB stored + $0.15 / GB egress.
- Cert: free.

Pre-mainnet steady-state: pennies per month.

---

## 5 · If things break

- **Build fails: `mdbook: command not found`** — `amplify.yml`
  downloads it to `/tmp`. If the URL changed (mdBook tags shifted),
  bump `MDBOOK_VERSION`.
- **Build fails: artifacts not found at `book`** — likely the build
  errored before `mdbook build` ran. Scroll the log for the
  underlying message.
- **Domain stays "Pending verification"** — re-read the validation
  CNAME at Namecheap. Just the prefix in Host, no trailing dot.
- **404 on a deep link** — confirm the chapter exists in
  `src/SUMMARY.md` and the build picked it up. mdBook silently skips
  files missing from SUMMARY.
