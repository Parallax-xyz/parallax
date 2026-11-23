# Security policy

Parallax code signs transactions with agent wallets that hold real money. Please report vulnerabilities privately.

## Reporting a vulnerability

- Use GitHub's private vulnerability reporting: **Security → Advisories → Report a vulnerability** on
  <https://github.com/Parallax-xyz/parallax/security/advisories/new>.
- Do not open a public issue, pull request or discussion for a vulnerability, and do not test against wallets or
  agents you do not own.
- Include what is affected (package, file, version or commit), how to reproduce it, and what an attacker could do.

We acknowledge reports as soon as we can, keep you informed while we fix the issue, and credit you in the advisory if
you wish.

## Scope

In scope: everything in this repository, in particular key handling (`EncryptedKeyVault`), anything that builds,
signs or sends a transaction (`@parallax/solana`), the risk engine and gas checks (`@parallax/risk`,
`@parallax/runner`), and the privacy code (`@parallax/privacy`).

Out of scope: third-party services and SDKs (Jupiter, Jito, Helius, RPC providers, AI model endpoints), unless the
problem is in how this code uses them.

## Never send secrets

Never put a private key, seed phrase, API key or master key in a report, an issue or a pull request. Nobody from
Parallax will ever ask you for one.
