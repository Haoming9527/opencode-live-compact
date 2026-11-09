# Publish a new version

This guide covers releases of [opencode-live-compact](https://www.npmjs.com/package/opencode-live-compact). Run commands from this repository's root with Node.js 22.18 or newer.

## 1. Choose an unused version

npm cannot overwrite a published version. Check existing versions before preparing the next patch:

```sh
npm view opencode-live-compact versions --json
npm version patch --no-git-tag-version
```

This increments the patch version in both `package.json` and `package-lock.json` without creating a Git commit or tag. Review both files before publishing.

## 2. Check the release

```sh
npm ci
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```

Integration tests require stock OpenCode **2.2.6** and use a local provider with no paid model calls. Check that the package contains compiled `dist/`, the license, READMEs, and selected documentation. Credentials and benchmark artifacts stay outside the package.

## 3. Publish

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public --registry=https://registry.npmjs.org/
```

Complete npm's browser sign-in and any requested two-factor verification. Publishing builds the plugin through the `prepack` script and uploads the new version.

## 4. Verify the published version

For the 0.1.1 example:

```sh
npm view opencode-live-compact@0.1.1 version dist.integrity
opencode plugin add opencode-live-compact@0.1.1
```

Use the actual release version in these commands. Restart OpenCode and verify the installed plugin. The `plugin add` command installs into OpenCode's global configuration.

[npm version command](https://docs.npmjs.com/cli/v11/commands/npm-version/) · [npm publishing guide](https://docs.npmjs.com/cli/v11/commands/npm-publish/) · [OpenCode plugin installation](https://opencode.ai/docs/plugins#manage)
