# DMH v2 Offline Verifier

This narrow CLI independently verifies phrase derivation and creates EIP-712 claim signatures. It makes no network calls and is not a replacement for the primary web application.

```bash
python3 -m venv .venv
.venv/bin/pip install -r dmh-cli/requirements.txt
.venv/bin/python dmh-cli/dmh.py verify-vectors
```

Use `derive --help` or `sign-claim --help` for required public vault parameters. Phrase input is hidden. Private keys are not displayed unless `--show-private-key` is explicitly supplied.
