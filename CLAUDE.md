# Air X

Send contacts, text, images, and files to a nearby device by ggwave sound or QR
code, no server. Sibling of [airgap](https://github.com/JakeAve/airgap), which
uses the same transports for games. Deno 2 + TypeScript, plain HTML and CSS.

## Workflow

`main` is protected: no direct pushes, no force pushes. Every change lands
through a PR.

Always work in a git worktree under `.worktrees/`, never in the main checkout:

```bash
git fetch origin main
git worktree add .worktrees/<branch> -b <branch> origin/main
```

Branches are `feat/<thing>` or `fix/<thing>`. Open a PR with a real title when
the task is done. Once it merges, `git worktree remove .worktrees/<branch>`,
delete the branch, and `git pull` in the main checkout.

Run `deno task setup` in a fresh clone to install the hooks. Worktrees share the
repo's git config, so they get the hooks automatically. Pre-commit and pre-push
run `deno task check` and `deno task test`.
