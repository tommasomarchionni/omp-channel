/**
 * Makes an error message safe to hand to a service. The text comes from a model provider and can
 * quote a request: secrets are hidden before it leaves the machine. Known shapes, not a guarantee;
 * `failures.includeReason: false` keeps the reason on the machine.
 */

export const MAX_REASON_LENGTH = 500;
export const MAX_ACTIVITY_LENGTH = 240;
const MAX_TOOL_NAME_LENGTH = 80;

/** Argument values shorter than this are not looked for in an intent: they are ordinary words. */
const MIN_ARGUMENT_LENGTH = 4;
/** The field of a tool call that holds the intent itself. */
const INTENT_ARGUMENT = "i";
const MAX_ARGUMENT_DEPTH = 4;
const MAX_ARGUMENT_VALUES = 200;
/** How much of an intent is read. */
const MAX_INTENT_READ = 4_000;

const HIDDEN = "[hidden]";

/** A private key block, from its first line to its last one, or to the end of the text. */
const KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

const SECRET_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // The credentials of an address (scheme://user:password@host): the host stays.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]+@/gi, `$1${HIDDEN}@`],
  // The query of an address can carry keys.
  [/\b(https?:\/\/[^\s?#]+)\?[^\s"')]+/gi, `$1?${HIDDEN}`],
  [
    /\b(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi,
    `$1${HIDDEN}`,
  ],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${HIDDEN}`],
  // key=value and key: value for names that hold secrets.
  [
    /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{3,}/gi,
    `$1${HIDDEN}`,
  ],
  // Tokens of known services.
  [/\b(?:sk|rk|pk)[-_][A-Za-z0-9_*-]{8,}/g, HIDDEN],
  [/\b(?:gh[pousr]_|github_pat_|npm_|hf_)[A-Za-z0-9_]{16,}/g, HIDDEN],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, HIDDEN],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN],
  // The home folder names the person.
  [/(?:\/Users|\/home)\/[^\s/"':]+/g, "~"],
  [/[A-Za-z]:\\Users\\[^\s\\"':]+/g, "~"],
];

/** A long token of random look: 32 or more characters with upper case, lower case and digits. */
const LONG_TOKEN = /[A-Za-z0-9_+=-]{32,}/g;

/**
 * One line, secrets hidden, at most `MAX_REASON_LENGTH` characters. Undefined when nothing is
 * left. Secrets are hidden before the cut, so a cut never leaves part of one.
 */
export function cleanReason(raw: string): string | undefined {
  return cut(hideSecrets(oneLine(raw)), MAX_REASON_LENGTH);
}

/**
 * The same hiding for a longer text that keeps its lines: the answer a model wrote without using
 * the reply tool. At most `maxLength` characters. Undefined when nothing is left.
 */
export function cleanText(raw: string, maxLength: number): string | undefined {
  return cut(hideSecrets(withoutControls(raw, "\n\t")).trim(), maxLength);
}

/**
 * The line of one tool use: the tool name and the intent stated for the call, on one line of at
 * most `MAX_ACTIVITY_LENGTH` characters. The intent is free text, and some tools build it from
 * their arguments, so every argument value quoted in it is left out, and so are secrets, paths and
 * addresses. Known shapes and exact quotes only, not a guarantee.
 */
export function activityText(toolName: string, intent: string | undefined, args: unknown): string {
  const name = cut(hideSecrets(oneLine(toolName)), MAX_TOOL_NAME_LENGTH) ?? "tool";
  const read = oneLine((intent ?? "").slice(0, MAX_INTENT_READ));
  const said =
    read === "" ? "" : hidePaths(hideSecrets(withoutArguments(read, argumentTexts(args, read))));
  // Nothing but placeholders and punctuation says nothing.
  const words = said.replace(/\[(?:hidden|path)\]|…/g, "");
  const line = /[\p{L}\p{N}]/u.test(words) ? `${name}: ${said}` : name;
  return cut(line, MAX_ACTIVITY_LENGTH) ?? name;
}

/** The texts among the arguments of a call that the intent could quote, longest first. */
function argumentTexts(args: unknown, intent: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (found.length >= MAX_ARGUMENT_VALUES) {
      return;
    }
    if (typeof value === "string") {
      // The content of a file, for one: far too long to be quoted, and not worth reading.
      const text = value.length > 2 * intent.length + 100 ? "" : oneLine(value);
      if (text.length >= MIN_ARGUMENT_LENGTH && text.length <= intent.length) {
        found.push(text);
      }
    } else if (typeof value === "object" && value !== null && depth < MAX_ARGUMENT_DEPTH) {
      for (const [key, inner] of Object.entries(value)) {
        if (depth > 0 || key !== INTENT_ARGUMENT) {
          visit(inner, depth + 1);
        }
      }
    }
  };
  visit(args, 0);
  return found.sort((a, b) => b.length - a.length);
}

/** Replaces each argument quoted as whole words. */
function withoutArguments(text: string, values: readonly string[]): string {
  let result = text;
  for (const value of values) {
    const literal = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${literal}(?![\\p{L}\\p{N}])`, "giu"),
      "…",
    );
  }
  return result;
}

/** Replaces the words that look like a path or an address, keeping the punctuation around them. */
function hidePaths(text: string): string {
  return text.replace(/\S+/g, (token) => {
    const [, before = "", word = "", after = ""] =
      /^([("'`<{]*)(.*?)([)"'`>}.,:;!?]*)$/.exec(token) ?? [];
    return looksLikePath(word) ? `${before}[path]${after}` : token;
  });
}

function looksLikePath(word: string): boolean {
  return (
    // An address, with its scheme.
    /[a-z][a-z0-9+.-]*:\/\//i.test(word) ||
    // From the root, the home folder or the current one, also after `=` or `:`.
    /(?:^|[=:])(?:~|\.{1,2})?\/./.test(word) ||
    word.includes("\\") ||
    // Two folders, or a folder and a file name with an extension.
    /\/.*\//.test(word) ||
    /\/[^/]*\.[A-Za-z0-9]{1,8}$/.test(word)
  );
}

function hideSecrets(raw: string): string {
  let text = raw.replace(KEY_BLOCK, HIDDEN);
  for (const [pattern, replacement] of SECRET_SHAPES) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(LONG_TOKEN, (token) =>
    /[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token) ? HIDDEN : token,
  );
}

function cut(text: string, maxLength: number): string | undefined {
  const symbols = [...text];
  if (symbols.length === 0) {
    return undefined;
  }
  return symbols.length <= maxLength ? text : `${symbols.slice(0, maxLength - 1).join("")}…`;
}

function oneLine(text: string): string {
  return withoutControls(text, "").replace(/\s+/g, " ").trim();
}

/** Control characters become spaces, except those in `keep`. */
function withoutControls(text: string, keep: string): string {
  let result = "";
  for (const symbol of text) {
    const code = symbol.codePointAt(0) ?? 0;
    const control = code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
    result += control && !keep.includes(symbol) ? " " : symbol;
  }
  return result;
}
