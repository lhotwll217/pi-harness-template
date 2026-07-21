# Pi Harness Template — Development

This file owns repository policy. Start with [`README.md`](README.md) for project
orientation, then use its documentation map to select the owning page under
[`docs/`](docs/). Read any nearer `AGENTS.md` before working within a subtree.

The repository is being ported toward its end state: a running,
self-documenting, demonstrative harness at MVP level.
[`docs/porting.md`](docs/porting.md) owns the active plan and work packages. Do
not describe planned behavior as implemented.

- **Keep a chain of context.** Route readers from this file to the README, from
  the README to the owning page, and from each page to narrower contracts.
- **Name things for what they are.** Avoid generic files and catch-all pages.
  A name should import a mental model the reader already has: use the term the
  field has converged on, and coin one only when the concept is genuinely new.
- **Keep one durable owner.** Point to an existing contract instead of restating
  it in README, prompts, comments, or another page.
- **Write for progressive discovery.** A reader should be able to stop after the
  README, choose a surface from routing metadata, and go deeper only as needed.
- **Separate decisions from proposals.** Mark unresolved implementation choices
  and never imply that an outline is working software.
- **Cite causal claims granularly.** Prefer pinned upstream sources when a design
  adopts a maintained external pattern.
- **Do not reinvent.** Search Pi and maintained open-source capabilities before
  designing local infrastructure; record the adopted source or rejection reason.
- **Make complexity earn its keep.** Start with the smallest boundary that
  preserves the required invariant.
- **Make durable text independent.** Docs, comments, and prompts must make sense
  without the conversation that produced them.
