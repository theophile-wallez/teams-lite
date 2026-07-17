/**
 * Session worktree automation.
 *
 * On session start: creates an isolated git worktree on a dedicated branch so
 * every opencode session works in isolation from the local master checkout.
 *
 * On session idle (agent considers its work done): commits, pushes the branch,
 * runs the test suite AS A HARD GATE, and only merges into master if the tests
 * pass. Red tests => no merge, the branch is left intact for inspection.
 *
 * The test gate runs on the branch BEFORE the merge, which is the only ordering
 * that actually keeps master green.
 */

const WORKTREE_ROOT = ".worktrees";
const MASTER_BRANCH = "master";
const TEST_COMMAND = "cargo test";

type SessionState = {
  branch: string;
  worktreePath: string;
};

// Keyed by session id so concurrent sessions never share a worktree.
const sessions = new Map<string, SessionState>();

export const SessionWorktree = async ({ $, directory }) => {
  const log = (msg: string) =>
    console.log(`[session-worktree] ${msg}`);

  const run = async (cmd: TemplateStringsArray, ...args: unknown[]) => {
    // Never throw on non-zero: we branch on exit codes explicitly.
    return await $(cmd, ...args).nothrow();
  };

  const stamp = () =>
    new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

  return {
    event: async ({ event }) => {
      // --- Session start: create the worktree ---
      if (event.type === "session.created") {
        const sessionId = event.properties?.info?.id ?? `s-${stamp()}`;
        if (sessions.has(sessionId)) return;

        const branch = `session/${stamp()}`;
        const worktreePath = `${WORKTREE_ROOT}/${branch.replace("/", "-")}`;

        // Make sure the base is up to date before branching.
        await run`git -C ${directory} fetch origin ${MASTER_BRANCH}`;
        const add = await run`git -C ${directory} worktree add -b ${branch} ${worktreePath} ${MASTER_BRANCH}`;

        if (add.exitCode !== 0) {
          log(`FAILED to create worktree for ${branch}: ${add.stderr}`);
          return;
        }

        sessions.set(sessionId, { branch, worktreePath });
        log(`created worktree ${worktreePath} on branch ${branch}`);
        return;
      }

      // --- Session idle: commit -> push -> TEST GATE -> merge ---
      if (event.type === "session.idle") {
        const sessionId = event.properties?.info?.id;
        const state = sessionId ? sessions.get(sessionId) : undefined;
        if (!state) return;

        const { branch, worktreePath } = state;
        const wt = `${directory}/${worktreePath}`;

        // Nothing changed? Skip everything, drop the empty worktree.
        const status = await run`git -C ${wt} status --porcelain`;
        if (status.exitCode === 0 && status.stdout.trim() === "") {
          log(`no changes on ${branch}, cleaning up worktree`);
          await run`git -C ${directory} worktree remove --force ${worktreePath}`;
          await run`git -C ${directory} branch -D ${branch}`;
          sessions.delete(sessionId!);
          return;
        }

        // 1. Commit.
        await run`git -C ${wt} add -A`;
        const commit = await run`git -C ${wt} commit -m ${`chore: session work on ${branch}`}`;
        if (commit.exitCode !== 0) {
          log(`commit failed on ${branch}: ${commit.stderr}`);
          return;
        }
        log(`committed on ${branch}`);

        // 2. Push the branch (keeps work safe even if the merge is blocked).
        const push = await run`git -C ${wt} push -u origin ${branch}`;
        if (push.exitCode !== 0) {
          log(`push failed on ${branch}: ${push.stderr} (work is committed locally)`);
        } else {
          log(`pushed ${branch}`);
        }

        // 3. HARD TEST GATE — runs on the branch, before any merge.
        log(`running test gate: ${TEST_COMMAND}`);
        const tests = await run`sh -c ${`cd ${wt} && ${TEST_COMMAND}`}`;
        if (tests.exitCode !== 0) {
          log(
            `TEST GATE FAILED on ${branch}. NO MERGE. master stays clean. ` +
              `Branch is pushed for inspection.`,
          );
          return;
        }
        log(`test gate passed on ${branch}`);

        // 4. Merge into master (--no-ff to keep a traceable merge commit).
        await run`git -C ${directory} fetch origin ${MASTER_BRANCH}`;
        const checkout = await run`git -C ${directory} checkout ${MASTER_BRANCH}`;
        if (checkout.exitCode !== 0) {
          log(`could not checkout ${MASTER_BRANCH}: ${checkout.stderr}. Branch left for manual merge.`);
          return;
        }
        await run`git -C ${directory} pull --ff-only origin ${MASTER_BRANCH}`;

        const merge = await run`git -C ${directory} merge --no-ff ${branch} -m ${`merge: ${branch}`}`;
        if (merge.exitCode !== 0) {
          log(`MERGE CONFLICT merging ${branch} into ${MASTER_BRANCH}. Aborting merge, branch left for manual resolution.`);
          await run`git -C ${directory} merge --abort`;
          return;
        }

        const pushMaster = await run`git -C ${directory} push origin ${MASTER_BRANCH}`;
        if (pushMaster.exitCode !== 0) {
          log(`merged locally but push to ${MASTER_BRANCH} failed: ${pushMaster.stderr}`);
          return;
        }
        log(`merged ${branch} into ${MASTER_BRANCH} and pushed`);

        // 5. Cleanup.
        await run`git -C ${directory} worktree remove --force ${worktreePath}`;
        await run`git -C ${directory} branch -d ${branch}`;
        sessions.delete(sessionId!);
        log(`cleaned up worktree for ${branch}`);
      }
    },
  };
};
