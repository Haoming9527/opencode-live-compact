# Publish to npm

GitHub hosts the source. npm hosts the installable package used by `opencode plugin add`.

The package is prepared as **opencode-live-compact@0.1.0**. Run these commands from this repository's root using Node.js 22.18 or newer.

## 1. Check the release

```sh
npm ci
npm run typecheck
npm test
npm run test:integration
npm pack --dry-run
```

The integration tests require stock OpenCode **2.2.6** and use a local provider, with no paid model calls. Check the package file list: compiled `dist/`, the license, READMEs, and selected documentation only. Credentials and benchmark artifacts must stay out of the npm package.

## 2. Sign in and publish

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public
```

Use your own npm account and complete the browser sign-in and any two-factor verification npm requests. `npm publish` builds the plugin automatically through the `prepack` script. This command makes version **0.1.0** public; each later release needs a new version number.

## 3. Verify installation

```sh
npm view opencode-live-compact@0.1.0 version
opencode plugin add opencode-live-compact
```

Restart OpenCode. The `plugin add` command installs into OpenCode's global configuration. After confirming publication, remove the pending-publication notice from both READMEs.

For later releases, update `package.json` and `package-lock.json` together, repeat the checks, and publish the new version. npm does not let you overwrite an already published version.

[npm publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/) · [OpenCode plugin installation](https://opencode.ai/docs/plugins#manage)
