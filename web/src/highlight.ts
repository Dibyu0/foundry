/** Tiny hand-rolled syntax highlighter for html/css/js/json. Produces plain
 *  token lists that React renders as spans — no HTML injection, no deps. */

export interface Token {
  text: string;
  cls: string | null;
}

export type Lang = 'html' | 'css' | 'js' | 'json' | 'plain';

export function langFor(path: string): Lang {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'html' || ext === 'htm' || ext === 'svg') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') return 'js';
  if (ext === 'json') return 'json';
  return 'plain';
}

/** Fallback color per token class, tuned for the editor surface token
 *  (--editor-bg, fallback #090c11). Renderers use var(--tok-x, fallback) so
 *  styles.css can re-theme from :root without touching markup. Every fallback
 *  passes WCAG AA (>= 4.5:1) against both #090c11 and the legacy --bg-0.
 *
 *  tok-c comment | tok-s string | tok-k keyword | tok-n number | tok-f call
 *  tok-a attr/prop | tok-t tag/selector | tok-p punct | tok-d doctype/dim
 *  tok-b boolean/null constant | tok-r regex literal | tok-e string escape */
export const TOKEN_FALLBACKS: Record<string, string> = {
  'tok-c': '#8b98ab',
  'tok-s': '#9fd6a3',
  'tok-k': '#c792ea',
  'tok-n': '#f78c6c',
  'tok-f': '#82aaff',
  'tok-a': '#6ec6ff',
  'tok-t': '#ff8a5c',
  'tok-p': '#8fa3bf',
  'tok-d': '#707b8a',
  'tok-b': '#ffcb6b',
  'tok-r': '#5eead4',
  'tok-e': '#ffd479',
};

interface GroupDef {
  name: string;
  re: RegExp;
  cls: string;
}

function runGroups(src: string, defs: GroupDef[]): Token[] {
  const combined = new RegExp(defs.map((d) => `(?<${d.name}>${d.re.source})`).join('|'), 'gms');
  const clsByName = new Map(defs.map((d) => [d.name, d.cls]));
  const tokens: Token[] = [];
  let last = 0;
  for (let m = combined.exec(src); m !== null; m = combined.exec(src)) {
    if (m.index > last) tokens.push({ text: src.slice(last, m.index), cls: null });
    let cls: string | null = null;
    const groups = m.groups ?? {};
    for (const name of Object.keys(groups)) {
      if (groups[name] !== undefined) {
        cls = clsByName.get(name) ?? null;
        break;
      }
    }
    tokens.push({ text: m[0], cls });
    last = m.index + m[0].length;
    if (m[0].length === 0) combined.lastIndex += 1;
  }
  if (last < src.length) tokens.push({ text: src.slice(last), cls: null });
  return tokens;
}

const JS_CODE_DEFS: GroupDef[] = [
  { name: 'constant', re: /\b(?:true|false|null|undefined|NaN|Infinity)\b/, cls: 'tok-b' },
  {
    name: 'keyword',
    re: /\b(?:const|let|var|function|return|if|else|for|while|do|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|switch|case|default|import|export|from|as|async|await|yield|static|get|set|void|delete)\b/,
    cls: 'tok-k',
  },
  {
    name: 'number',
    re: /(?:0x[\da-fA-F_]+|0b[01_]+|0o[0-7_]+|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?|\.\d+(?:[eE][+-]?\d+)?)/,
    cls: 'tok-n',
  },
  { name: 'call', re: /[A-Za-z_$][\w$]*(?=\s*\()/, cls: 'tok-f' },
  { name: 'prop', re: /\.[A-Za-z_$][\w$]*/, cls: 'tok-a' },
];

/** Keywords after which a `/` opens a regex rather than a division. */
const REGEX_PREFIX_WORDS = new Set([
  'return',
  'typeof',
  'case',
  'throw',
  'else',
  'do',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'instanceof',
  'await',
  'yield',
]);

/** Heuristic: a `/` starts a regex literal when the previous significant
 *  token cannot end an expression (operator, opener, or prefix keyword). */
function regexAllowedBefore(src: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k -= 1;
  if (k < 0) return true;
  const pc = src[k];
  if ('([{,;:=!&|?+-*~^<>%\n'.includes(pc)) return true;
  if (/[A-Za-z_$]/.test(pc)) {
    const m = /[A-Za-z_$][\w$]*$/.exec(src.slice(0, k + 1));
    if (m && REGEX_PREFIX_WORDS.has(m[0])) return true;
  }
  return false;
}

type JsState = 'code' | 'sq' | 'dq' | 'tpl' | 'line-comment' | 'block-comment';

/** State-machine tokenizer for js: strings ('' "") with escape sequences
 *  (tok-e), template literals with ${} expressions (nestable), regex literals
 *  (tok-r, heuristic), line/block comments; plain code spans go through the
 *  keyword/constant/number groups. */
function tokenizeJs(src: string): Token[] {
  const tokens: Token[] = [];
  let state: JsState = 'code';
  let segStart = 0;
  let depth = 0;
  // brace depth of each open ${ — when a } brings depth back to it, the
  // template expression is over and the literal resumes
  const tplExpr: number[] = [];
  const flushCode = (end: number) => {
    if (end > segStart) tokens.push(...runGroups(src.slice(segStart, end), JS_CODE_DEFS));
  };
  const flush = (cls: string, end: number) => {
    if (end > segStart) tokens.push({ text: src.slice(segStart, end), cls });
  };
  // split a string/template span into string chunks and escape sequences
  const flushString = (end: number) => {
    let chunk = segStart;
    let k = segStart;
    while (k < end) {
      if (src[k] === '\\' && k + 1 < end) {
        if (k > chunk) tokens.push({ text: src.slice(chunk, k), cls: 'tok-s' });
        let e = k + 2;
        if (src[k + 1] === 'x') e = Math.min(end, k + 4);
        else if (src[k + 1] === 'u') {
          if (src[k + 2] === '{') {
            const close = src.indexOf('}', k + 3);
            e = close === -1 || close >= end ? k + 3 : close + 1;
          } else e = Math.min(end, k + 6);
        }
        tokens.push({ text: src.slice(k, e), cls: 'tok-e' });
        k = e;
        chunk = e;
        continue;
      }
      k += 1;
    }
    if (end > chunk) tokens.push({ text: src.slice(chunk, end), cls: 'tok-s' });
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        flushCode(i);
        state = 'line-comment';
        segStart = i;
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        flushCode(i);
        state = 'block-comment';
        segStart = i;
        i += 2;
        continue;
      }
      if (c === '/' && regexAllowedBefore(src, i)) {
        flushCode(i);
        segStart = i;
        let j = i + 1;
        let inClass = false;
        while (j < src.length) {
          const ch = src[j];
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === '\n') break;
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            j += 1;
            break;
          }
          j += 1;
        }
        while (j < src.length && /[a-z]/.test(src[j])) j += 1;
        flush('tok-r', j);
        segStart = j;
        i = j;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        flushCode(i);
        state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
        segStart = i;
        i += 1;
        continue;
      }
      if (c === '{') depth += 1;
      if (c === '}') {
        if (tplExpr.length > 0 && depth === tplExpr[tplExpr.length - 1]) {
          flushCode(i);
          tplExpr.pop();
          state = 'tpl';
          segStart = i;
          i += 1;
          continue;
        }
        if (depth > 0) depth -= 1;
      }
      i += 1;
      continue;
    }
    if (state === 'sq' || state === 'dq') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === (state === 'sq' ? "'" : '"')) {
        flushString(i + 1);
        state = 'code';
        segStart = i + 1;
      } else if (c === '\n') {
        // unterminated string: JS source lines cannot carry a raw quote across
        flushString(i);
        state = 'code';
        segStart = i;
      }
      i += 1;
      continue;
    }
    if (state === 'tpl') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        flushString(i + 1);
        state = 'code';
        segStart = i + 1;
        i += 1;
        continue;
      }
      if (c === '$' && next === '{') {
        flushString(i);
        tokens.push({ text: '${', cls: 'tok-s' });
        tplExpr.push(depth);
        state = 'code';
        segStart = i + 2;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'line-comment') {
      if (c === '\n') {
        flush('tok-c', i);
        state = 'code';
        segStart = i;
      }
      i += 1;
      continue;
    }
    // block-comment
    if (c === '*' && next === '/') {
      flush('tok-c', i + 2);
      state = 'code';
      segStart = i + 2;
      i += 2;
      continue;
    }
    i += 1;
  }
  if (state === 'code') flushCode(src.length);
  else if (state === 'line-comment' || state === 'block-comment') flush('tok-c', src.length);
  else flushString(src.length);
  return tokens;
}

const CSS_DEFS: GroupDef[] = [
  { name: 'comment', re: /\/\*[\s\S]*?\*\//, cls: 'tok-c' },
  { name: 'atrule', re: /@[\w-]+/, cls: 'tok-k' },
  { name: 'string', re: /"[^"\n]*"|'[^'\n]*'/, cls: 'tok-s' },
  { name: 'selector', re: /[^{}\n]+(?=\{)/, cls: 'tok-t' },
  { name: 'property', re: /[a-zA-Z-]+(?=\s*:)/, cls: 'tok-a' },
  { name: 'func', re: /[\w-]+(?=\()/, cls: 'tok-f' },
  {
    name: 'number',
    re: /#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|svh|lvh|dvh|s|ms|deg|fr|ch|ex|vmin|vmax|cm|mm|in|pt|pc)?\b/,
    cls: 'tok-n',
  },
  { name: 'punct', re: /[{};]|!important/, cls: 'tok-p' },
];

const JSON_DEFS: GroupDef[] = [
  { name: 'key', re: /"(?:[^"\\\n]|\\.)*"(?=\s*:)/, cls: 'tok-a' },
  { name: 'string', re: /"(?:[^"\\\n]|\\.)*"/, cls: 'tok-s' },
  { name: 'constant', re: /\b(?:true|false|null)\b/, cls: 'tok-b' },
  { name: 'number', re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, cls: 'tok-n' },
  { name: 'punct', re: /[[\]{},:]/, cls: 'tok-p' },
];

function tokenizeHtml(src: string): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      tokens.push({ text: buf, cls: null });
      buf = '';
    }
  };
  const push = (text: string, cls: string | null) => {
    if (text) tokens.push({ text, cls });
  };
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end === -1 ? src.length : end + 3;
      flush();
      push(src.slice(i, stop), 'tok-c');
      i = stop;
      continue;
    }
    if (src.startsWith('<!', i) || src.startsWith('<?', i)) {
      const end = src.indexOf('>', i);
      const stop = end === -1 ? src.length : end + 1;
      flush();
      push(src.slice(i, stop), 'tok-d');
      i = stop;
      continue;
    }
    if (src[i] === '<' && /[a-zA-Z/]/.test(src[i + 1] ?? '')) {
      flush();
      let j = i + 1;
      let isCloseTag = false;
      if (src[j] === '/') {
        isCloseTag = true;
        j += 1;
      }
      const name = /^[a-zA-Z][\w-]*/.exec(src.slice(j));
      if (!name) {
        buf += src[i];
        i += 1;
        continue;
      }
      push(src.slice(i, j), 'tok-p');
      push(name[0], 'tok-t');
      j += name[0].length;
      while (j < src.length && src[j] !== '>') {
        if (src[j] === '/' && src[j + 1] === '>') break;
        const ws = /^\s+/.exec(src.slice(j));
        if (ws) {
          push(ws[0], null);
          j += ws[0].length;
          continue;
        }
        const quoted = /^(?:"[^"]*"|'[^']*')/.exec(src.slice(j));
        if (quoted) {
          push(quoted[0], 'tok-s');
          j += quoted[0].length;
          continue;
        }
        const attr = /^[^\s=/>]+/.exec(src.slice(j));
        if (attr) {
          push(attr[0], 'tok-a');
          j += attr[0].length;
          continue;
        }
        push(src[j], 'tok-p');
        j += 1;
      }
      let close = '';
      if (j < src.length) {
        close = src.startsWith('/>', j) ? '/>' : '>';
        push(close, 'tok-p');
        j += close.length;
      }
      // inline script/style bodies get the full js/css tokenizers
      const tag = name[0].toLowerCase();
      if (close === '>' && !isCloseTag && (tag === 'script' || tag === 'style')) {
        const closer = tag === 'script' ? /<\/script\s*>/i : /<\/style\s*>/i;
        const rest = src.slice(j);
        const m = closer.exec(rest);
        const innerLen = m ? m.index : rest.length;
        if (innerLen > 0) {
          const inner = rest.slice(0, innerLen);
          tokens.push(...(tag === 'script' ? tokenizeJs(inner) : runGroups(inner, CSS_DEFS)));
          j += innerLen;
        }
      }
      i = j;
      continue;
    }
    const entity = /^&[\w#]+;/.exec(src.slice(i));
    if (entity) {
      flush();
      push(entity[0], 'tok-n');
      i += entity[0].length;
      continue;
    }
    buf += src[i];
    i += 1;
  }
  flush();
  return tokens;
}

export function tokensToLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const t of tokens) {
    const parts = t.text.split('\n');
    for (let k = 0; k < parts.length; k += 1) {
      if (k > 0) lines.push([]);
      if (parts[k]) lines[lines.length - 1].push({ text: parts[k], cls: t.cls });
    }
  }
  return lines;
}

export function highlightLines(content: string, lang: Lang): Token[][] {
  if (lang === 'html') return tokensToLines(tokenizeHtml(content));
  if (lang === 'css') return tokensToLines(runGroups(content, CSS_DEFS));
  if (lang === 'js') return tokensToLines(tokenizeJs(content));
  if (lang === 'json') return tokensToLines(runGroups(content, JSON_DEFS));
  return tokensToLines([{ text: content, cls: null }]);
}
