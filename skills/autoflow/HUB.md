# Hub workspace

Read this when the workspace holds more than one repository. The caller proves that shape before passing this path. A single-repo workspace needs none of it, and its phase skills stay literal.

## Shape

Three facts differ from a single-repo run:

- **The cwd is the artifact root.** Plans, brainstorms, reviews, manual tests, and mocks live here, and the transition check resolves against it.
- **Code lives in child repositories.** Each child is its own Git root with its own `AGENTS.md`, its own codemap, and its own test suite.
- **Durable records go where they are relevant.** A child keeps its own codemap, glossary, and decision records.

This document supplies the multiplier. Where a phase step says "commit", read one commit per repository. Where it says "run the tests", read one run per repository, inside that repository. Phase skills never restate those loops.

## The workspace section

Architect writes a `## Workspace` section in the plan. Every later phase reads it.

```markdown
## Workspace

| repo   | path                     | shape   | test-base | impl-base |
|--------|--------------------------|---------|-----------|-----------|
| my-pi  | /home/alenna/repos/my-pi | symlink | 9b6acb4   | 51dcacd   |
| pimote | /home/alenna/repos/pimote| symlink | ad5a029   | 609a3e1   |
```

- `path` is absolute and resolves to a directory.
- `shape` is `local`, `symlink`, or `worktree-detached`.
- `test-base` and `impl-base` start empty.
- One row per repository the feature touches. The cwd takes no row.

A plan without this section is a single-repo plan. Every predicate that reads the section is skipped for it.

## Baselines

Two stamps per row, both recorded before any edit in that repository.

- **test-write** fills `test-base`.
- **implement** fills `impl-base`.
- Stamp every row the phase will touch before writing any file. A stamp placed after the first edit silently widens that repository's review scope.
- A repository discovered late keeps an empty earlier column. Review falls back to `impl-base`.
- A row with no base takes no diff. That covers a repository that only receives a decision record.

Review diffs each row from `test-base`, falling back to `impl-base`. The test-immutability check diffs the plan's test files from each row's `impl-base`. Cleanup scopes its codemap scan from `impl-base`.

A changed file belongs to the row with the longest matching path prefix. Plan paths stay hub-relative and need no new syntax.

## Commits

- Commit from the repository's own path: `git -C <path> commit …`.
- A bare `git commit` from the cwd commits the artifact root.
- One commit per repository per phase. Group by phase, not by file.
- The artifact-root commit carries run artifacts only.
- Never stage a child repository from the root. A child Git root is not a file.

## Delegation

| Delegate | cwd |
|---|---|
| Phase agent for any covered phase | artifact root |
| Implement worker whose steps sit in one repository | that repository |
| Implement worker owning one change across repositories | artifact root |
| Review pass | artifact root |
| Cleanup codemap or docs agent | the repository it updates |
| Manual-test driver | artifact root |

Rules:

- Pass absolute artifact paths whenever a child's cwd is not the artifact root. A relative plan path resolves against the child's cwd and fails.
- Pass this document's absolute path to every child you spawn. Children do not detect the workspace shape themselves.
- Never send a child into a folder that declares `kind: persona`.
- Review and handle-review children keep the cwd they started with. Resurrection cannot change it, and autoflow resurrects the review agent for re-review.

## Branches

A worktree hub holds members as detached checkouts. A commit on a detached `HEAD` is unreachable from a branch ref, and Pimote then refuses to disband the hub.

- Before the first commit in a `worktree-detached` row, create one branch in that checkout: `git -C <path> switch -c <topic>`.
- The branch survives disband, in the source repository. Report its name at cleanup.

## Phase obligations

### architect

Write the `## Workspace` section after the architecture settles. Record the repositories the feature touches, not every workspace member. Record each repository's verify command and its directory.

### test-write

Stamp `test-base` for every row before writing a file. Run the red gate in each repository, from that repository's directory, with that repository's runner. Commit tests in their owning repository.

### impl-plan

Every step names its repository and its verify directory. A step that names neither is unusable in a hub.

### implement

Stamp `impl-base` before the first edit. Commit each repository as its own steps finish. Run cross-cutting verification per repository, never once from the root. In orchestrated mode, a worker's cwd comes from its step ownership.

### review

Both passes diff each row from that row's base. A `Location:` carries the repository, since a bare path is ambiguous across members. The correctness pass reads the `AGENTS.md` of each repository it diffs.

Check contract parity across repositories. A contract split between two repositories passes both per-repository reviews while disagreeing at the seam. Verify the producer's shape against the consumer's expectation.

### handle-review

Commit each finding's fix in the repository that owns the changed file.

### manual-test

The system under test spans repositories. Drivers run from the artifact root. The persistent suite lives in the repository that owns each journey's entry point, and its journeys name the repositories they cross. Read every suite in the workspace. Bootstrap a suite only in the repository that owns the new journey.

### cleanup

Use `impl-base` per row for the codemap scan. Run one codemap agent per repository. Place each decision record in the repository it is most relevant to. Report the branch names created for worktree rows. Delete run artifacts from the artifact root and commit that removal there.

## Gates

`check-transition.ts` validates these when the plan has a workspace section:

- Every row carries `repo`, `path`, and a valid `shape`.
- Every path resolves to a directory.
- Every recorded base is a commit in its own repository.
- A `worktree-detached` row has a `HEAD` contained in a branch ref.

Run it from the artifact root, or pass the root explicitly:

```
npx tsx <absolute path to check-transition.ts> <phase> <topic> [--root <artifact-root>]
```
