# Security

## What the page holds

FreeDEX is static files. The page holds no key and no seed, runs no server, and keeps no account. It reads public
boxes from an Ergo explorer, builds transactions in your browser, and hands them to your wallet (Nautilus or SAFEW
by EIP-12) or to your phone (the Ergo mobile wallet or Terminus by ErgoPay, as a QR code) to confirm, sign and
submit. The only things written to your browser's storage are the explorer you chose and, on the phone path, the
address you typed. The page sends nothing to any host but the explorer backends it reads from; there is no
telemetry, analytics or error reporting. The keyless chain upkeep submits transactions that spend nobody's boxes but
the contract boxes anyone may act on, with no signature.

What that means for a report: a vulnerability here is a page that builds a transaction other than the one it
describes, shows a figure other than the one the contract will enforce, lets chain-sourced text reach the page as
markup, or reaches a host it should not. The contracts the page builds against are listed with their bytes and
sources in `src/registry.json`; what each builder checks and what it leaves to the contract is written down in
`docs/invariants/`.

## Reporting

Report privately through GitHub's private vulnerability reporting for this repository:
https://github.com/cafebedouin/freedex/security/advisories/new. Please do not open a public issue for a
vulnerability until it is fixed and deployed. Expect an acknowledgement within a week; this is a one-person
project with no bounty programme.

## Scope

In scope: everything under `src/`, `contracts/`, `index.html` and the deployed page at
https://cafebedouin.github.io/freedex/. Out of scope: the third-party contracts the page builds against (ErgoDEX,
Machina, SigmaFi, SigmaUSD, TokenJay, EIP-31 Babel), the wallets, and the explorer backends; a finding there should
go to its own maintainers, though a note here is welcome if the page should stop relying on it.
