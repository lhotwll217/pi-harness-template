# Docs

This folder is the single home for durable behavior knowledge. README, code, and
prompts route here; they do not create competing specifications.

- **Every page starts with routing frontmatter.** `title`, a one-line `summary`,
  and nonempty `read_when` triggers let a reader choose a page without first
  reading its body. The summary says what the page is; `read_when` alone says
  when to read it.
- **One page owns one surface.** Overlapping material merges into one owner or
  becomes a link to that owner.
- **State contract level explicitly.** Separate current project direction,
  proposed implementation detail, and unresolved decisions.
- **Point at executable contracts once they exist.** Future schemas, catalogs,
  and parsers should document themselves; pages should link instead of copying.
- **Write only the current contract.** Before saving, ask what context the text
  assumes, what future change could silently falsify it, and where else the same
  claim appears.
