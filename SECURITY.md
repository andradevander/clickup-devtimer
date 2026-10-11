# Security Policy

## Supported Versions

Only the latest released version of ClickUp DevTimer receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report them privately through GitHub's
[Private vulnerability reporting](https://github.com/andradevander/clickup-devtimer/security/advisories/new).

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (or a proof of concept)
- The extension version, VS Code version and operating system

**Never include a real ClickUp Personal Token in a report.** If a token was exposed, revoke it right away in ClickUp under _Settings → Apps → API Token → Regenerate_.

### What to expect

- Acknowledgement within **5 business days**
- An initial assessment and next steps within **10 business days**
- Credit in the release notes once a fix ships, unless you prefer to stay anonymous

## Security Model

- The ClickUp Personal Token is stored only in the VS Code **SecretStorage** API (OS keychain). It is never written to settings, logs or the extension's state files.
- The token is sent only to `https://api.clickup.com`.
- The extension does not collect telemetry.
