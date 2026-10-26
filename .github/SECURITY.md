# Security Policy

## Supported Versions

We actively maintain security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.8.x   | ✅ Active Security Updates |
| 0.7.x   | ⚠️ Critical Fixes Only |
| < 0.7.0 | ❌ No Longer Maintained |

## Reporting a Vulnerability

**Please do NOT file public issues for security vulnerabilities.**

If you discover a security vulnerability in QingYue, please report it privately:

### Contact Methods

1. **Email**: `security@yourdomain.com` (replace with your actual email)
2. **GitHub Security Advisories**: Use the "Security" tab on this repository
3. **Preferred Method**: [Create a private fork and open PR](https://docs.github.com/en/code-security/security-advisory/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)

### What to Include

When reporting, please provide:
- Description of the vulnerability
- Steps to reproduce
- Potential impact (data access, DoS, privilege escalation, etc.)
- Your contact information for follow-up

### Response Time

We commit to:
- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Patch Release**: Priority fix for critical issues
- **Communication**: Regular updates during remediation

## Our Security Model

QingYue's default security boundaries:

1. **Local-Only Binding**: Defaults to `127.0.0.1:1234`, no external exposure
2. **No Authentication**: Designed as a local service (no accounts/passwords)
3. **Same-Origin Protection**: Write operations require matching Origin header
4. **SSRF Guard**: Outbound requests filtered to public internet only
5. **Optional LAN Exposure**: Setting `LEGADO_HOST=0.0.0.0` exposes write access to LAN

⚠️ **Important**: Never expose QingYue to the public internet without additional authentication/proxies!

## Security Best Practices

### For Users

1. Keep `LEGADO_HOST=127.0.0.1` unless you specifically need LAN access
2. Monitor firewall rules if running on shared networks
3. Don't share API keys from `agent-profiles.json`
4. Regularly update to latest version for security patches

### For Developers

1. Review changes to `http/Guard.kt` when modifying auth logic
2. Test SSRF filters (`NetworkSecurity.kt`) before exposing externally
3. Sanitize all input, even though we don't have user accounts

## PGP Verification

For verified releases, we use GPG signing:
```bash
git tag -v v0.8.4  # verify signature
```

Public key available at: [YourKeyServer](https://keyserver.ubuntu.com/pks/lookup?search=your-email)

---

Last Updated: October 21, 2026
