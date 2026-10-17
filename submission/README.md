# Submission

`project.json` holds the project entry for the Monad Blitz Shanghai submission (fields `name`,
`description`, `url`, `github`). The description is in Simplified Chinese (about 600 characters) and
only uses numbers measured on Monad testnet on 2026-10-17 (see the main [README](../README.md)).

- `url`: the GuardedAdmin contract on the Monad testnet explorer.
- `github`: the public repository URL. Push the repository before submitting so the link resolves.

## Submitting with `mojo-submit.sh`

`mojo-submit.sh` is the author's private helper for the event's agent API; it is not part of this
repository and reads its API credential from a private file outside the repo. Only the author runs it.

```bash
# 1. dry run: validates project.json (all four fields present, url/github are https) and prints the payload
bash mojo-submit.sh submission/project.json warroom-veto.png warroom-v2.png

# 2. send: uploads the screenshots, then creates the project (or updates it if it already exists)
SEND=1 bash mojo-submit.sh submission/project.json warroom-veto.png warroom-v2.png
#    the script asks for confirmation; type "yes"
```

Notes:

- At least one screenshot is required; png, jpg, gif or webp, 10 MB each at most. Suggested shots: the
  war room after the EvilMint veto (3/3 sentinels, `ProposalVetoed`), and after v2 executed.
- Running it again with `SEND=1` updates the same project entry.
- After sending, the project is pending until the organisers review it.

Checklist before `SEND=1`:

1. The GitHub repository is pushed and public at the `github` URL.
2. The numbers in `description` still match the latest testnet run.
3. Screenshots contain no private keys, file paths or terminal windows.
