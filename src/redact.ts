/**
 * Makes an error message safe to hand to a service. The text comes from a model provider and can
 * quote a request: secrets are hidden before it leaves the machine. Known shapes, not a guarantee;
 * `failures.includeReason: false` keeps the reason on the machine.
 */

export const MAX_REASON_LENGTH = 500;

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
