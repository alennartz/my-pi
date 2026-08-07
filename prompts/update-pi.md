---
description: Audit pi SDK upgrade path — breaking changes and improvement opportunities
---

Audit the upgrade path for pi and its related npm packages from the version currently in use to the latest available.

## Workflow

1. Read `codemap.md` to understand which parts of the package interact with pi.
2. Find all `@earendil-works/*` packages declared in `package.json` and note their currently installed versions.
3. Look up the latest published versions of all discovered `@earendil-works/*` packages on npm.
4. Retrieve the changelogs between the referenced versions in package.json and the latest published versions for each package that has a more recent version.
5. If there are no breaking changes announced in the changelogs. then just update the references in package.json to the latest, commit and end your turn.
6. Otherwise, based on your knowledge of the codemap but without exploring the codebase, group the breaking changes by area of this repo they are likely to impact.
7. COncurrently, for each group spawn a subagent that will investigate if the specific set of breaking changes you list to it actually impact us, their task is to dig into the code and see if the break causes issues, if not they should report that back. if yes they should propose how the situation could be resolved but not make any changes themselves.
8. once all subagents return if the breaks do not impact us just update the references in package.json to the latest, commit and end your turn.
9. Otherwise, discuss with the user the impacts of the breaks and the proposed fixes.
10. once the fixes have implemented and commited. think about if any of the changelog changes might result in improvement or simplifications to our extensions. if you think some might exist ask the user if they want you to look in to that in more detail.