# Releasing

Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. It runs
the tests and creates a GitHub release with the changelog notes and the add-on package.

Without AMO keys the package is unsigned (`zenbridge-x.y.z-unsigned.xpi`); upload it to
addons.mozilla.org to have it signed. With keys, the workflow signs it itself (unlisted),
attaches the signed `.xpi` and deploys the install page to GitHub Pages.

## Optional: sign in CI

Store your AMO API credentials on the `release` environment (only `v*` tags can use it):

```bash
gh secret set AMO_API_KEY --env release
```

```bash
gh secret set AMO_API_SECRET --env release
```

## Each release

1. Bump `version` in `extension/manifest.json` and the `serverInfo` version in
   `server/zenbridge_mcp.py`.
2. Add a `## [x.y.z] - date` section to `CHANGELOG.md`.
3. Commit, then tag and push:

   ```bash
   git tag v1.4.1 && git push origin main v1.4.1
   ```

Every build shows up under **Releases** (with its changes) and **Deployments**
(`release` and `github-pages`) on the repository page.

Note: AMO version numbers are unique across channels. A version signed here as
unlisted can't also be submitted as listed, so bump the version for a store submission.

## Supply chain

The release job can hold the AMO signing key, so nothing it runs may change under it:

- Every `uses:` in the workflows is pinned to a full commit SHA with a `# vX.Y.Z` comment.
  Dependabot (`.github/dependabot.yml`) proposes updates; review each one before merging.
- `web-ext` is pinned exactly in `package.json` and `package-lock.json` and installed with
  `npm ci --ignore-scripts`. Run it locally the same way:

  ```bash
  npm ci --ignore-scripts && npm run lint
  ```

- Checkouts don't keep the GitHub token (`persist-credentials: false`).
- `tests/test_workflows.py` fails if any of this regresses.

Repository settings that complete it (not stored in the repo): required reviewers on the
`release` environment, a tag ruleset that restricts who can create or move `v*` tags, and
two-factor authentication on both the GitHub and addons.mozilla.org accounts.
