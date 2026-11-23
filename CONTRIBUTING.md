# Contributing

Thank you for helping improve Parallax.

## Setup

Node.js 22 or newer.

```sh
npm ci
npm run build
npm test
npm run lint      # biome; `npm run format` rewrites formatting
npm run typecheck # sources and tests
```

## Pull requests

- Keep a pull request to one change, with tests for new behavior. Tests run on fakes: no network, no real keys.
- Code that can move money (risk rules, gas checks, swaps, wallets, privacy) needs a test that shows the limit holds.
- Write code comments and documentation in plain English. Keep the existing style: TypeScript strict, ES modules,
  biome formatting.
- Never commit secrets, `.env` files, keys or databases.
- By contributing you agree that your contribution is licensed under the Apache License 2.0.

Report security problems privately, see [SECURITY.md](SECURITY.md).
