// Outside allow mode the agent's bash reaches no shell: the harness splits the command itself
// and runs the launcher with argv. The permission extension strips a leading `VAR=` before it
// matches the generated `pi-template <command> *` rules, so its allow cannot vouch for the text.

const PLAIN = /[A-Za-z0-9_\-.,:@%+=/]/;

export type AgentCliCommand = { argv: string[] } | { refused: string };

/** Splits a POSIX command line limited to plain words and quotes; the first word must be `pi-template`. */
export function agentCliArgv(command: string): AgentCliCommand {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(command)) return { refused: "it has a control character" };
  const words: string[] = [];
  let word: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === " " || char === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return { refused: "a quote is not closed" };
      word = (word ?? "") + command.slice(index + 1, end);
      index = end;
    } else if (char === '"') {
      const end = command.indexOf('"', index + 1);
      if (end < 0) return { refused: "a quote is not closed" };
      const quoted = command.slice(index + 1, end);
      const special = /[$`\\]/.exec(quoted);
      if (special) return { refused: `it has ${special[0]} inside double quotes` };
      word = (word ?? "") + quoted;
      index = end;
    } else if (PLAIN.test(char)) {
      word = (word ?? "") + char;
    } else {
      return { refused: `it has ${char} outside quotes` };
    }
  }
  if (word !== undefined) words.push(word);
  if (words.length === 0) return { refused: "it is empty" };
  const [first, ...argv] = words;
  return first === "pi-template" ? { argv } : { refused: "its first word is not pi-template" };
}

export const agentCliRefusal = (mode: string, reason: string): string =>
  `Refused in ${mode} mode: the agent's bash runs only pi-template <command> [arguments] as plain words, and ${reason}. ` +
  `Quote arguments with '...' or "..."; variables, redirects, pipes, globs, and chained commands are refused.`;

export const shellWords = (argv: readonly string[]): string =>
  argv.map((value) => `'${value.replaceAll("'", `'\\''`)}'`).join(" ");
