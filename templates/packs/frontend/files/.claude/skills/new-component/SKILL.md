---
name: new-component
description: Adds a new component to a UI project by mirroring an existing sibling component's conventions, then runs it through the test-author, code-implementer and ui-reviewer loop. Use for /new-component, "add a new component", "scaffold a component", "create a UI component", or when asked for a component that should look and be tested like the ones already in the project.
argument-hint: "[component-name]"
---

# new-component

A new component should look like the ones already in the project: same
folder layout, naming, props style, test style and, where the project has
them, story or example files. Shipping fixed templates would be wrong for
most projects (the framework is unknown here), so this skill reads a
**sibling** component and copies its conventions instead of inventing new
ones.

The hub plans and dispatches; it never writes `src/` or test code itself.
Writing is the job of `test-author` and `code-implementer`.

## Steps

### 1 — Find a sibling

Find the closest existing component to the one being asked for: same kind
(a form control, a layout piece, a list item), same folder, or the most
recently added. Read it in full, with its test file and any story or example
file beside it. Record, in a short list:

- the **framework** and file extensions in use (read them from the sibling
  and from `package.json`; never assume one);
- where files live and how they are named (one folder per component or one
  file, an index file, a barrel export);
- how props or inputs are typed, how state is held, how styles are attached;
- how the sibling is tested and what it asserts;
- how the sibling handles accessibility: element choice, labels, keyboard
  handling, focus.

If there is no sibling (the project has no component yet), stop and ask the
owner which framework and conventions to use. Do not pick a framework and do
not add a **dependency** to make a component possible: a new package is a
decision for the owner, not a side effect of this skill.

### 2 — Write the contract

Before any code, write the component's contract in a few lines: its name and
location (mirroring the sibling), its props or inputs, its states (default,
disabled, loading, error, empty), its keyboard behaviour, and its accessible
name and role. Settle the element first: prefer a native element (`button`,
`a`, `input`) over a generic element with a role added.

Confirm anything the sibling does not answer with the owner before going on.

### 3 — Run the loop

1. `test-author` writes failing tests from the contract, following the
   sibling's test style, and confirms they fail for the right reason.
2. `code-implementer` makes them pass, following the sibling's layout and
   naming, and adds the story or example file only if the sibling has one.
3. `ui-reviewer` reviews the new files for accessibility. Name the files to
   review in the dispatch prompt, since it has no shell. `code-reviewer` runs
   alongside it as usual.
4. Must-fix findings go back to `code-implementer`, and the loop repeats until
   clean.

If the project has no `test-author` or `code-implementer` (an adopted project
that dropped them), say so and stop: ask the owner to restore the writer
spokes, because the hub never writes `src/` itself.

### 4 — Report

Say which sibling was mirrored, the files added, what `ui-reviewer` reported
including everything it listed as NOT CHECKED, and the checks only a browser
or a screen reader can settle.
