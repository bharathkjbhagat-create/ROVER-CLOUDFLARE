# DEFENX isolated face-preview deployment

This workflow deploys the current feature branch to a separate Worker named
`defenx-face-preview`. It does not deploy to or overwrite the production
`defenx` Worker. It is manual-only and must not be triggered until the
preview-only GitHub Actions secrets below have been configured.

## Required repository secrets

In GitHub, open **Settings → Secrets and variables → Actions → New repository
secret** and add:

| Secret name | Value |
|---|---|
| `PREVIEW_CLOUDFLARE_API_TOKEN` | A Cloudflare API token scoped to the DEFENX account with Workers Scripts edit permission. Do not paste it into chat. |
| `PREVIEW_CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID that owns the preview Worker. |
| `PREVIEW_ADMIN_USERNAME` | A new username used only for the preview. |
| `PREVIEW_ADMIN_PASSWORD` | A new strong password used only for the preview. Do not reuse the production password. |
| `PREVIEW_SESSION_SECRET` | A new random secret of at least 32 characters, used only by preview. |
| `PREVIEW_FACE_DATA_KEY` | A new random secret of at least 32 characters, used only by preview. Back it up securely; losing it makes preview biometric records unreadable. |

Optional:
- `PREVIEW_ROVER_DEVICE_TOKEN`: a separate device token for a preview rover simulator/device. Never reuse the production device token.

Do not copy production `DATABASE_URL`, live device tokens, production admin
credentials, or the production face-data key into preview. The preview uses its
own Worker identity and Durable Object binding; it should contain only test
accounts and synthetic/test images.

## Run the preview

1. Open **Actions → Deploy DEFENX isolated face preview**.
2. Select **Run workflow** on branch `feature/face-verification-registry`.
3. Wait for the job to finish.
4. Open `https://defenx-face-preview.bindukjagadish.workers.dev` only if the
   workflow's smoke tests pass.

The workflow performs source tests, deploys the isolated Worker, applies only
the preview-specific secrets, redeploys, and checks the login and health
endpoints. It does not change the production Worker or merge the pull request.

## Safety boundary

Use synthetic or consenting test subjects only. Do not upload real biometric
data until the encryption design has received an independent review and
real-camera accuracy, liveness, and mask-detection limitations have been
evaluated. Face matching is not proof of identity and must not be used as the
sole access-control mechanism.
