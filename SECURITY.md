# Security Policy

## Reporting a Vulnerability

We take the security of Zaplie seriously. Because this project moves real value
over the Bitcoin Lightning Network (via LNbits wallets), security reports are
treated with the highest priority.

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Instead, report vulnerabilities privately through one of these channels:

| Channel | Details |
|---------|---------|
| Email | [support@knowall.ai](mailto:support@knowall.ai) |
| Nostr (encrypted DM) | `npub1jutptdc2m8kgjmudtws095qk2tcale0eemvp4j2xnjnl4nh6669slrf04x` (Ben Weeks) |

When reporting, please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept code or requests are welcome)
- The component affected (Teams bot, `tabs/` web app, `functions/` Azure
  Functions, or the LNbits integration)
- Any suggested remediation, if you have one

## What to Expect

- **Acknowledgement** within 3 working days of your report.
- **Assessment and triage** — we will confirm the issue, assess severity, and
  keep you informed of progress.
- **Fix and disclosure** — we aim to remediate confirmed vulnerabilities
  promptly and will credit reporters (with permission) once a fix is released.

We ask that you practise responsible disclosure: give us reasonable time to fix
the issue before any public disclosure, and do not access, modify, or exfiltrate
data (or funds) beyond what is necessary to demonstrate the vulnerability.

## Scope

Of particular interest:

- Anything allowing unauthorised movement of funds (Sats) between LNbits wallets
- Exposure of LNbits admin/invoice keys or service-account credentials
- Authentication or authorisation bypass in the Teams bot, the MSAL-protected
  web tabs, or the Azure Functions endpoints
- Injection or SSRF via bot commands, adaptive cards, or the LNbits proxy

## Supported Versions

Security fixes are applied to the `main` branch. Deployments should track the
latest release.
