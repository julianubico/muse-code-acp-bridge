# Publishing

Releases are published by `.github/workflows/publish.yml` with npm Trusted
Publishing (GitHub Actions OIDC). The workflow contains no npm token or
`.npmrc` credential.

Before the first release, verify the package name is available and configure a
trusted publisher for `muse-code-acp-bridge` on npm with:

- repository: `julianubico/muse-code-acp-bridge`;
- workflow file: `.github/workflows/publish.yml`;
- permission: publish;
- no long-lived npm token.

npm requires the package to exist before a trusted-publisher relationship can
be created. If the registry requires a one-time authenticated bootstrap for
the initial package, perform that interactively with npm and configure Trusted
Publishing immediately afterward; do not commit or add the credential to the
repository. All subsequent releases should run through the workflow.

The workflow can be started manually or by publishing a GitHub release. It
runs the tests, packed-artifact checks, and package safety checks before
publishing.
