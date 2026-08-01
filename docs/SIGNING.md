# Code Signing & Notarization

This guide explains how to configure **Windows code signing**, **macOS Developer ID signing**, and **Apple notarization** for VPS Commander's release pipeline so that shipped installers are signed (and pass Gatekeeper / SmartScreen checks).

Once configured, the `release.yml` workflow automatically signs builds on every tag push — **no code changes required** beyond setting secrets. (Enabling *notarization* additionally needs one small config change in `package.json` — see [§5](#5-enable-notarization-in-the-build-config).)

---

## Why sign?

| Platform | What signing buys you | Without it |
|----------|----------------------|------------|
| Windows | Authenticode signature — fewer SmartScreen warnings, publisher name shown | "Unknown publisher" warnings |
| macOS | Developer ID signature + notarization — no Gatekeeper block | "cannot be opened because the developer cannot be verified" |
| macOS (auto-update) | electron-updater **requires** a signed app to self-update | Updates open the Releases page instead |

---

## 1. Windows Code Signing

### Get a certificate

Buy a code-signing certificate from any trusted CA (DigiCert, Sectigo, GlobalSign, etc.). Standard (OV) certs work for VPS Commander; EV certs additionally clear SmartScreen reputation faster but need a hardware token (not CI-friendly).

You receive a `.pfx` (or `.p12`) file protected by a password. **Never commit it** — it goes into GitHub secrets as base64.

### Encode the certificate (PowerShell, on Windows)

```powershell
# From a local cert store (after installing the .pfx):
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like "*Your Name*" } | Select-Object -First 1
Export-PfxCertificate -Cert $cert -FilePath C:\temp\vps-commander.pfx -Password (ConvertTo-SecureString "YourPfxPassword" -Force -AsPlainText)

# Or, if you already have the .pfx file, just base64-encode it:
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\temp\vps-commander.pfx")) | Set-Content -Encoding Ascii C:\temp\vps-commander-base64.txt
```

Copy the base64 string (the single long line in `vps-commander-base64.txt`) — this is the value for `WIN_CSC_LINK`.

---

## 2. macOS Signing (Developer ID)

### Prerequisites

- Paid **Apple Developer Program** membership (US$99/year) — required for Developer ID certificates and notarization.
- Xcode (or at least Command Line Tools) on the machine you use to export the certificate.

### Create a Developer ID Application certificate

1. Sign in at [developer.apple.com/account](https://developer.apple.com/account).
2. Go to **Certificates, Identifiers & Profiles → Certificates → Create → Developer ID Application**.
3. Follow the CSR flow (Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority).
4. Download the certificate and double-click to install it into your login keychain.

### Export as .p12 (Keychain Access)

1. Open **Keychain Access** → *My Certificates*.
2. Right-click your **Developer ID Application** certificate → **Export**.
3. Save as `DeveloperID.p12`, set a strong password (this is the cert password — different from your Apple account password).
4. Base64-encode it:

```bash
base64 -i DeveloperID.p12 -o DeveloperID-base64.txt
# or
openssl base64 -in DeveloperID.p12 -out DeveloperID-base64.txt
```

Copy the single-line base64 value — this is `MAC_CSC_LINK`.

### Find your Team ID

- **Apple Developer portal** → top-right account menu → **Membership details** → Team ID (a 10-character string like `ABCDE12345`).
- Also shown on the certificate itself in Keychain Access.

---

## 3. Apple Notarization (v2 — API Key, recommended)

Notarization sends the signed app to Apple's servers for a malware scan and staples a ticket. **Recommended method:** App Store Connect API keys (v2), which are CI-friendly and don't rotate like app-specific passwords.

> **Note on v1 (legacy):** you can also notarize with your Apple ID + app-specific password (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). It still works in electron-builder 26.x but the API-key method is preferred.

### Create an App Store Connect API key

1. Sign in to [appstoreconnect.apple.com](https://appstoreconnect.apple.com).
2. **Users and Access → Integrations → App Store Connect API → Generate API Key**.
3. Give it **App Manager** or **Developer** role access (Developer is sufficient for notarization).
4. Download the `.p8` private key file (**you can only download it once**). Note the **Key ID** and the **Issuer ID** shown on that page.

### Encode the .p8 key

```bash
base64 -i AuthKey_XXXXXXXXXX.p8 -o AuthKey-base64.txt
```

This single-line value is `APPLE_API_KEY`. (electron-builder accepts the base64 contents directly.)

---

## 4. Configure GitHub Secrets

Go to **repo → Settings → Secrets and variables → Actions → New repository secret**, or use the CLI:

```bash
# Windows cert
gh secret set WIN_CSC_LINK
# (paste the base64 .pfx)
gh secret set WIN_CSC_KEY_PASSWORD
# (paste the .pfx password)

# macOS cert
gh secret set MAC_CSC_LINK
# (paste the base64 .p12)
gh secret set MAC_CSC_KEY_PASSWORD
# (paste the .p12 password)

# Apple notarization (v2 — API key)
gh secret set APPLE_API_KEY
# (paste the base64 .p8)
gh secret set APPLE_API_KEY_ID
# (paste the Key ID, e.g. ABC1234XYZ)
gh secret set APPLE_API_ISSUER
# (paste the Issuer ID UUID)
```

> The generic `CSC_LINK` / `CSC_KEY_PASSWORD` also work if you only sign one platform; the platform-prefixed names (`WIN_*`, `MAC_*`) let you keep separate certs per OS and are what this workflow expects.

---

## 5. Enable notarization in the build config

The workflow passes the secrets through, but electron-builder only notarizes when told to. Add the `notarize` block to the `mac` section of `package.json`:

```json
"mac": {
  "target": ["dmg", "zip"],
  "icon": "public/icon.png",
  "category": "public.app-category.utilities",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "entitlements.mac.plist",
  "entitlementsInherit": "entitlements.mac.plist",
  "notarize": {
    "teamId": "YOUR_TEAM_ID"
  }
}
```

**Replace `YOUR_TEAM_ID` with your real Team ID** (e.g. `ABCDE12345`). electron-updater's auto-update requires `hardenedRuntime: true` (already set) and a signed build.

> **Order matters:** configure the `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` secrets **first**, then add the `notarize` block. If the block is enabled while the secrets are unset, every macOS release build fails because electron-builder tries to notarize with empty credentials.

> If you prefer the v1 Apple ID method instead of API keys, set `"notarize": true` and provide `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` secrets instead.

---

## 6. How the workflow consumes them

The `build` job in `.github/workflows/release.yml` exposes the secrets as environment variables **only when they exist**:

```yaml
env:
  # Only set when the secret is configured; empty otherwise.
  WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
  WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}
  MAC_CSC_LINK: ${{ secrets.MAC_CSC_LINK }}
  MAC_CSC_KEY_PASSWORD: ${{ secrets.MAC_CSC_KEY_PASSWORD }}
  APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
  APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
  APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
```

- **Windows** builds run on `windows-latest`; electron-builder signs the `.exe` with the `.pfx` decoded from `WIN_CSC_LINK`.
- **macOS** builds run on `macos-latest` (signing must happen on macOS — codesign tools are macOS-only); electron-builder signs with the `.p12` from `MAC_CSC_LINK`, then notarizes with the API key.
- `CSC_IDENTITY_AUTO_DISCOVERY: "false"` stays set so electron-builder never hangs probing local keychains when no secrets are present.
- Linux (AppImage/deb) is unsigned by design — Linux has no equivalent per-app signature requirement.

---

## 7. Verify a signed release

> **CI enforces this automatically.** The `release.yml` workflow now verifies signatures on tag builds: Windows runs `Get-AuthenticodeSignature` on every `.exe` (must be `Valid`) and macOS runs `codesign --verify --deep --strict` plus `spctl -a -vv` (when notarization secrets are set) on the `.app` bundle — a broken/missing signature fails the release job before artifacts are uploaded. These checks only run when the corresponding signing secrets are configured, so fully unsigned (no-secrets) releases still pass.

After a tag build completes, you can also check the release assets manually:

**Windows** — right-click the `.exe` → Properties → Digital Signatures, or:

```powershell
Get-AuthenticodeSignature "VPS Commander Setup 1.0.0.exe"
# Status should be: Valid
```

**macOS** — after download (on any Mac):

```bash
codesign -dv --verbose=2 "/Applications/VPS Commander.app"
# should print: Signature=Developer ID Application: Your Name (TEAMID)
# (if it prints "adhoc", the app is NOT properly signed)

spctl -a -vv "/Applications/VPS Commander.app"
# should print: accepted  source=Notarized Developer ID
```

---

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| Build fails with `identity not found` / `no valid identity` | The cert isn't in the base64 secret, or the wrong cert type. Ensure `WIN_CSC_LINK`/`MAC_CSC_LINK` are **base64 of the .pfx/.p12** and passwords match. |
| macOS `cannot be verified` warning | Build is signed but not notarized. Check `notarize` block in `package.json` and that `APPLE_API_KEY*` secrets are set. |
| Notarization fails with `Please provide an API key` (or empty-credential error) | The `notarize` block is enabled in `package.json` but `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` aren't set. Add the secrets (or temporarily disable the block). |
| Notarization fails with 403 | API key lacks permission or issuer/key ID is wrong. Confirm the key has Developer access and matches the `.p8` that was downloaded. |
| electron-updater says "no update available" on macOS | The installed app was built unsigned. Reinstall the newly signed release once. |
| Windows still shows "Unknown publisher" | SmartScreen reputation builds over time; the signature itself is valid if `Get-AuthenticodeSignature` says `Valid`. |

---

## Secret reference

| Secret | Value | Used for |
|--------|-------|----------|
| `WIN_CSC_LINK` | base64 of `.pfx` | Windows Authenticode signing |
| `WIN_CSC_KEY_PASSWORD` | `.pfx` password | Windows signing |
| `MAC_CSC_LINK` | base64 of `.p12` | macOS Developer ID signing |
| `MAC_CSC_KEY_PASSWORD` | `.p12` password | macOS signing |
| `APPLE_API_KEY` | base64 of `.p8` | Notarization (v2) |
| `APPLE_API_KEY_ID` | Key ID (10 chars) | Notarization (v2) |
| `APPLE_API_ISSUER` | Issuer ID (UUID) | Notarization (v2) |
| `APPLE_ID` *(optional, v1)* | Apple ID email | Notarization (v1, legacy) |
| `APPLE_APP_SPECIFIC_PASSWORD` *(optional, v1)* | App-specific password | Notarization (v1, legacy) |
| `APPLE_TEAM_ID` *(optional, v1)* | Team ID | Notarization (v1, legacy) |
