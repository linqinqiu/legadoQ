# Support for legadoQ

## Get Help

### 1. **Documentation** (First Stop)
- [Main README](../README.md) - Quick start and overview
- [Architecture Guide](docs/ARCHITECTURE.md) - System design
- [API Reference](docs/API-REFERENCE.md) - All 142 endpoints
- [AI Agent Guide](product/AGENTS.md) - AI integration
- [Plugin Development](docs/plugin-development-guide.md) - Extend functionality

### 2. **Common Issues**

#### Installation Problems
- Check `Node.js >= 20` and `Java >= 17` versions
- See [deploy.md](docs/deploy.md) for step-by-step installation
- Verify ports: default is `127.0.0.1:1234`

#### Book Source Issues
- Validate sources using `POST /api/sources/{id}/validate`
- Debug with `GET /api/sources/{id}/debug?keyword=xxx`
- Check [compatibility.md](docs/compatibility.md) for rules

#### AI Connection Failed
- Verify `agent-profiles.json` configuration
- Test connection: `GET /api/agent/connections`
- See [AI Framework docs](product/AGENTS.md)

### 3. **Community & Discussion**

#### Ask Questions
- [🚀 Ideas & Feature Requests](./DISCUSSION_TEMPLATE/ideas.yml)
- [📢 Show & Tell](./DISCUSSION_TEMPLATE/show-and-tell.yml)
- [❓ Bug Reports](./ISSUE_TEMPLATE/01-bug-report.yml)

#### Resources
- Search existing issues before opening new ones
- Include version info (check `/healthz`)
- Attach logs from `logs/server.log` when relevant

### 4. **Contributing**

Want to help? Great!

- 🐛 Found a bug? [File an issue](./ISSUE_TEMPLATE/01-bug-report.yml)
- 💡 Have a feature idea? [Start a discussion](./DISCUSSION_TEMPLATE/ideas.yml)
- 🔧 Want to contribute code? See [CONTRIBUTING.md](../CONTRIBUTING.md)
- 📚 Can improve docs? We welcome PRs!

### 5. **Professional Support**

For enterprise deployments or custom development:
- Email: contact via GitHub discussions
- Commercial licensing: see [LICENSE](../LICENSE) for terms

---

**Note**: Response times typically within 48 hours on weekdays. For urgent security issues, see [SECURITY.md](SECURITY.md).
