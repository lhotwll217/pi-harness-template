/** Workspace paths are `/`-separated and relative to the workspace root, as the Gateway lists them. */
export function pathName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function pathParent(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? undefined : path.slice(0, slash);
}

export function pathJoin(parent: string | undefined, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** `<stem><suffix>`, else `<stem> 2<suffix>`, `<stem> 3<suffix>` …, compared without case. */
export function nextAvailableName(taken: Iterable<string>, stem: string, suffix: string): string {
  const names = new Set([...taken].map((name) => name.toLowerCase()));
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? `${stem}${suffix}` : `${stem} ${index}${suffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}
