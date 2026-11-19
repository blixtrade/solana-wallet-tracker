# Contributing to solana-wallet-tracker

Thanks for helping. This is a small, zero-dependency Node.js project, so getting started takes a minute.

## Setup

You need [Node.js](https://nodejs.org) 22 or newer. Nothing else: no `npm install`, no API keys.

```bash
git clone https://github.com/<your-username>/solana-wallet-tracker.git
cd solana-wallet-tracker
npm test
```

All tests run offline against fixtures. Please keep it that way: new tests must not call live APIs.

## Picking an issue

1. Look for issues labelled `good first issue` (small, well scoped) or `help wanted` (bigger).
2. Comment on the issue to say you are taking it, so two people do not do the same work.
3. Each issue names the files involved and has a **Done when** line. That line is the definition of finished.

Have an idea that is not in the issues? Open an issue first and describe it before writing a lot of code.

## Making the change

- Keep the project dependency-free: use what Node 22 ships with (`fetch`, `node:test`, `WebSocket`).
- `lib/core.js` is shared word-for-word with the other [Blix Trade](https://github.com/blixtrade) tools. If you need to change it, say so in the PR and the maintainers will sync it everywhere.
- Add or update a test in `test/` for any behaviour change.
- Run `npm test` before you push.

## Pull requests

- One issue per pull request, with `Fixes #<number>` in the description.
- Describe what you changed and how you checked it. Paste real terminal output if the change affects what the CLI prints.
- Small and focused beats big and sweeping. Reviews are usually done within a day or two.

By contributing you agree your work is released under the [MIT License](LICENSE).
