# AWS deployment — runbook

The Pyde Book deploys to AWS as a static mdBook bundle behind
CloudFront. There is no SSR, no Lambda, no container. Everything below
is one-time console work; once it's in place the GitHub Actions
workflow at `.github/workflows/deploy.yml` keeps the bucket in sync on
every push to `main`.

```
Route 53 (pyde.network hosted zone)
        │
        ▼ (book.pyde.network alias)
CloudFront distribution  ──── ACM cert (us-east-1)
        │
        ▼ (Origin Access Control)
S3 bucket — private, blocked public access
        ▲
        │
GitHub Actions ── OIDC ── IAM role ── scoped policy
```

The marketing site at `pyde.network` is a separate stack with the same
shape; the runbook in [`pyde-net/website/docs/AWS_DEPLOYMENT.md`](https://github.com/pyde-net/website/blob/main/docs/AWS_DEPLOYMENT.md)
covers it. The two stacks share the Route 53 hosted zone and the IAM
OIDC provider; everything else is per-site.

---

## 1 · Build locally first

Before automating anything, prove the bundle works:

```bash
# Install mdbook 0.4.40 once (Rust toolchain):
cargo install mdbook --version 0.4.40
# Or download the binary from
# https://github.com/rust-lang/mdBook/releases/tag/v0.4.40

mdbook build
# Emits ./book — that's the directory S3 will hold.
```

Preview:

```bash
mdbook serve --open
# http://localhost:3000
```

---

## 2 · One-time AWS console setup

Region: **us-east-1** is mandatory for the ACM certificate CloudFront
uses. The S3 bucket itself can live in any region.

### 2.1 · Hosted zone

Route 53 → Hosted zones → `pyde.network`. If it already exists (the
website setup created it), reuse it. Otherwise create it and update the
registrar's name-servers to the four NS records AWS issues.

### 2.2 · S3 bucket

S3 → Create bucket → name `pyde-net-book-prod` (or similar).
- Block **all** public access.
- Versioning: enable.
- Default encryption: SSE-S3.

### 2.3 · ACM certificate

ACM → us-east-1 → Request certificate → public → fully-qualified
domain name: `book.pyde.network`. Validation: DNS. Accept ACM's
"Create records in Route 53" button. Wait for **Issued**.

### 2.4 · CloudFront distribution

CloudFront → Create distribution:

- **Origin domain**: `pyde-net-book-prod.s3.<region>.amazonaws.com`
  (the REST endpoint, not the website endpoint).
- **Origin access**: Origin access control → create new OAC, signing
  enabled, `sigv4`. CloudFront prints an inline bucket policy snippet —
  copy it.
- **Viewer protocol policy**: Redirect HTTP to HTTPS.
- **Allowed HTTP methods**: GET, HEAD.
- **Default cache behavior** → Cache policy: AWS-managed
  **CachingOptimized**. (HTML files override via the cache-control
  headers the workflow writes.)
- **Alternate domain names (CNAMEs)**: `book.pyde.network`.
- **Custom SSL certificate**: pick the ACM cert from §2.3.
- **Default root object**: `index.html`.
- **Custom error responses**: add `403 → /404.html (404)` and
  `404 → /404.html (404)` — mdBook emits a 404.html at the root.

Create. Wait for **Deployed** (~15 min).

Back at the S3 bucket: Permissions → Bucket policy → paste the OAC
snippet from the distribution.

### 2.5 · Route 53 alias record

Route 53 → `pyde.network` hosted zone → Create record:
- `book.pyde.network` → A record → Alias → CloudFront distribution.
- Same for AAAA (IPv6).

---

## 3 · Wire up GitHub Actions OIDC

If the marketing-site stack is already deployed, the OIDC provider at
§3.1 below already exists in the account — skip to §3.2 to add a role
scoped to this repo.

### 3.1 · OIDC provider (skip if already present)

IAM → Identity providers → Add provider:
- Provider type: OpenID Connect
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

### 3.2 · Role

IAM → Roles → Create role → Web identity:
- Identity provider: from §3.1.
- Audience: `sts.amazonaws.com`.
- GitHub organisation: `pyde-net`.
- GitHub repository: `pyde-book`.
- GitHub branch: `main`.

Trust policy (lock to `main`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:pyde-net/pyde-book:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

### 3.3 · Scoped policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::pyde-net-book-prod"
    },
    {
      "Sid": "ObjectRW",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::pyde-net-book-prod/*"
    },
    {
      "Sid": "Invalidate",
      "Effect": "Allow",
      "Action": ["cloudfront:CreateInvalidation"],
      "Resource": "arn:aws:cloudfront::<ACCOUNT_ID>:distribution/<DISTRIBUTION_ID>"
    }
  ]
}
```

### 3.4 · GitHub repo configuration

GitHub → `pyde-net/pyde-book` → Settings → Environments → `production`
(create if missing). Then Settings → Secrets and variables → Actions →
Variables tab:

| Name | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/<ROLE_NAME>` |
| `AWS_REGION` | `us-east-1` |
| `S3_BUCKET` | `pyde-net-book-prod` |
| `CLOUDFRONT_DISTRIBUTION_ID` | the distribution's 14-char `E…` ID |

---

## 4 · First push

```bash
git push origin main
```

Watch Actions → deploy. The pipeline should:
1. Download mdbook (~2 s).
2. Build (~5–10 s).
3. Assume the OIDC role (~3 s).
4. Sync `book/` → S3 with split cache-control.
5. Issue `cloudfront create-invalidation --paths /*`.

`curl https://book.pyde.network` should serve the new tree within a
minute.

---

## 5 · Bypassing the workflow

```bash
mdbook build
aws s3 sync book/ s3://pyde-net-book-prod/ --delete \
  --exclude "*.html" --exclude "*.txt" \
  --cache-control "public, max-age=31536000, immutable"
aws s3 sync book/ s3://pyde-net-book-prod/ \
  --exclude "*" --include "*.html" --include "*.txt" \
  --cache-control "public, max-age=0, must-revalidate"
aws cloudfront create-invalidation \
  --distribution-id <DISTRIBUTION_ID> --paths "/*"
```

---

## 6 · Retiring the old Vercel + GitHub-Pages paths

This repo previously deployed via:
- `vercel.json` — Vercel framework config.
- `.github/workflows/deploy-gh-pages.yml.legacy` — GitHub Pages fallback.

Both predate the AWS migration. Once `book.pyde.network` serves
correctly from CloudFront:

1. Delete the Vercel project from the dashboard.
2. Remove `vercel.json` from this repo.
3. Optionally delete the `.legacy` workflow file.
