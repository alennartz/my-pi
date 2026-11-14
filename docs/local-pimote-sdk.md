# Local Pimote SDK development

Use the local SDK link when editing Pimote's SDK and my-pi together.

## Link the SDK

Run this from my-pi:

```bash
npm run link:pimote-sdk
```

The command builds `../pimote/packages/sdk`, creates a global npm link, then links the package into my-pi's `node_modules`. It does not change `package.json` or `package-lock.json`.

## Keep declarations current

In another terminal, watch the SDK build:

```bash
cd ../pimote
npm run dev --workspace=@pimote/sdk
```

Run the my-pi type check after changing either repository:

```bash
cd ../my-pi
npm run typecheck
```

The pre-commit hook runs the same type check.

## Restore the registry dependency

Run this from my-pi:

```bash
npm ci
```

This removes the local `node_modules` link and installs the exact SDK version from the lockfile. To also remove npm's global link, run `npm unlink --global @pimote/sdk`.

The link does not change tracked files. Pimote deployment and clean installs use package-lock resolution. Before pushing my-pi code that needs new SDK types, publish the SDK version and update my-pi's pin through npm. Then run `npm ci` so the pre-commit hook and any clean CI install type-check the published contract.
