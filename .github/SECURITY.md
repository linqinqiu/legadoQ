# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅ Active |
| < 0.2   | ❌ No longer maintained |

The current release line is 0.2.x (see `VERSION` / `GET /healthz` for the exact version).

## Reporting a Vulnerability

**Please do NOT file public issues for security vulnerabilities.**

Report privately via **GitHub Security Advisories**: open the repository's
[Security tab](https://github.com/linqinqiu/legadoQ/security) and choose
"Report a vulnerability" ([how it works](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

When reporting, please include:

- Description of the vulnerability and the affected component
- Steps to reproduce (a minimal proof of concept is ideal)
- Potential impact (data access, SSRF bypass, sandbox escape, DoS, etc.)
- Your contact information for follow-up

This is a small personal project. Reports are handled on a best-effort basis;
critical issues (data loss, SSRF bypass, sandbox escape) are prioritized, and
you will receive updates as remediation progresses.

## Our Security Model

legadoQ's default security boundaries:

1. **Local-only binding**: defaults to `127.0.0.1:1234`; binding to a non-loopback
   address requires the explicit `LEGADO_ALLOW_EXTERNAL_BIND=1` opt-in.
2. **No authentication**: designed as a single-user local service (no accounts/passwords).
3. **Same-origin write gate**: write operations require a matching `Origin` header
   (`http/Guard.kt`), compared against the server identity to resist DNS rebinding.
4. **Outbound SSRF guard**: all outbound HTTP goes through `ops/NetworkSecurity.kt`
   (rejects loopback/private/link-local/reserved targets) via a loopback proxy that
   pins the validated IP at connection time (`ops/PinnedProxy.kt`), closing the
   DNS-rebinding TOCTOU window; redirects are re-validated per hop.
5. **Script sandbox**: book-source JavaScript runs in Rhino with a class shutter,
   an explicit Java-bridge whitelist, and wall-clock/memory budgets.

⚠️ **Important**: setting `LEGADO_HOST=0.0.0.0` hands write access to your LAN.
Never expose legadoQ to the public internet without an authenticating reverse
proxy (see `product/SECURITY.md` for the deployment baseline).

## Security Best Practices

### For Users

1. Keep the default loopback binding unless you specifically need LAN access.
2. Use an authenticating reverse proxy (TLS + Basic Auth/OAuth + IP allowlist) for any remote access.
3. Don't share API keys from `agent-profiles.json` (it is gitignored; keep it that way).
4. Update to the latest release for security fixes.

### For Developers

1. Review changes to `http/Guard.kt` when touching the write gate.
2. Route all new outbound HTTP through `NetworkSecurity.newHttpClient` — never a bare `HttpClient`.
3. Keep the sandbox whitelist and budgets intact; run `GoldenRuleTest` when touching the rule engine.

## Release Integrity

Each GitHub Release ships a `SHA256SUMS` file covering all assets; verify downloads
against it. Releases and tags are **not currently GPG-signed** — do not rely on
signature verification.

---

Last updated: 2026-11-14 (version line 0.2.x)