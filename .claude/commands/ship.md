# ship — land current branch on master, push to origin, remove the worktree (kept in T3 Code)

You are on a feature branch inside a worktree. Drive this to completion autonomously — investigate and fix problems rather than stopping.

## Steps

1. **Locate the repos and the branch:**
   ```
   git rev-parse --abbrev-ref HEAD   # current branch name
   git rev-parse --show-toplevel     # this worktree
   git worktree list                 # find main checkout (first entry, holds master)
   ```
   Refuse to ship from the main checkout itself: this command merges into `master` and needs a separate worktree.

2. **Commit the open work.** Stage the files of the task and write a conventional-commit message. No AI attribution, no `Co-Authored-By` line. The tree must be clean before the merge.

3. **Run the project's checks — this is the gate.** Match their scope to the scope of your change; `AGENTS.md` § Tests is the authority, and this is its short form:
   - Backend (`src/`, Rust): `cargo test`.
   - Web app (`web/`): `bun run test` and `bun run typecheck`; add `bun run test:e2e` when behavior or a flow changes.
   - The `teams` command (`launcher/`): `bun test` and `bun run typecheck`.
   - The hooks (`.claude/hooks/`): the matching `python3 .claude/hooks/<name>.test.py`.

   A frontend-only change does not need `cargo test`, and a backend-only change does not need the web suites. A change that spans a protocol or a WebSocket contract needs both sides. If a check fails, stop here, report it, and correct the cause. Never merge on a red check.

4. **Sync master with origin** in the main checkout:
   ```
   git -C <main> fetch origin master
   git -C <main> merge --ff-only origin/master
   ```
   If master has diverged from origin (not ff-only), investigate why (force-push? stale local?) and resolve it before continuing.

5. **Rebase the feature branch on the updated master** (in the worktree):
   ```
   git rebase master
   ```
   If there are conflicts, resolve them file by file, then `git rebase --continue`. Do not abort unless the conflict is genuinely unresolvable (e.g. both sides deleted the same file with incompatible intent) — in that case, explain and ask.

6. **Fast-forward master** in the main checkout:
   ```
   git -C <main> merge --ff-only <branch>
   ```
   This should always succeed after a clean rebase. If it doesn't, diagnose and fix.

7. **Push:**
   ```
   git -C <main> push origin master
   ```
   If the push is rejected because origin moved ahead, fetch + rebase again (step 4–6) and retry.

8. **Read the final sha now**, because the next step can delete the directory you stand in:
   ```
   git -C <main> rev-parse --short HEAD
   ```

9. **Remove the worktree and the branch.** Run every command with `-C <main>`, never a `cd`, because your own directory disappears:
   ```
   git -C <main> worktree remove --force <worktree>
   git -C <main> branch -d <branch>
   ```
   Use `ExitWorktree` with `action: "remove"` in place of these two commands when this session created the worktree with `EnterWorktree`, because the harness tracks that one.

   **Skip this step — keep the worktree and the branch — when the worktree path lies under `~/.t3/worktrees/`.** T3 Code owns that directory: it re-spawns the agent with the same working directory on every turn, so a removal kills the whole thread on the next message (`Path "…/t3code-<id>" does not exist`, then `Claude runtime stream failed`). The merge and the push are the point of this command; the cleanup is not. T3 Code removes its own worktree.

   Keep the worktree also when the user asks for it, or when you expect a follow-up commit in the same session.

   `git branch -d` refuses a branch that `master` does not hold, and this command never uses `-D`. A cleanup failure is only a warning: the merge and the push already stand, so report the warning, not a ship failure.

10. **Prune the build artifacts of a worktree that STAYS.** A kept worktree holds the whole build cache — a Rust `target/`, a `node_modules/`, the bundler output — and twenty of them filled a 98 GB disk with 53 GB of `target/` alone. The work is merged and pushed, so that cache is dead weight:
    ```
    .claude/scripts/prune-worktree-artifacts.sh <worktree>
    ```
    Run it whenever step 9 kept the worktree, T3 Code included. Skip it when step 9 removed the worktree, because the directory is already gone. The script refuses the primary checkout, deletes only a directory that git ignores, never follows a symlink (a borrowed `node_modules` link survives), and refuses a worktree that a build or a server is running in. It prints what it freed; report that number. A refusal is a warning, not a ship failure.

    The next build in that worktree is a cold one, which is the cost of the space. Say so in the report.

11. Report the final HEAD sha, the branch that you deleted, the space that step 10 freed, and confirm.

## What a push to `master` does in THIS repo

CI republishes the rolling `latest` release on every push to `master`, and every
install made by `install.sh` compares its own build commit against that release — so
the update button in the sidebar offers this push to everybody who runs the app, and
the always-on service re-stages itself from the checkout. `master` is not a staging
area here: step 3 is the only thing between a commit and three people's Teams client.
Never skip it.

## Principles
- Fix problems, don't just report them.
- Only ask the user when the situation is genuinely ambiguous (destructive conflict, unexpected divergence that could hide lost work, etc.).
- Never squash, force-push master, or touch any branch other than the feature branch and master.
- This command is the LAST action of the session when step 9 removes the worktree: the working directory is then gone, so run no tool in it, and write the report from the output you already hold. In a kept worktree (a T3 Code one, for example) the session continues normally.
