/** Tiny hand-rolled syntax highlighter for html/css/js. Produces plain token
 *  lists that React renders as spans — no HTML injection, no dependencies. */

export interface Token {
  text: string;
  cls: string | null;
}

export type Lang = 'html' | 'css' | 'js' | 'plain';

export function langFor(path: string): Lang {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'html' || ext === 'htm' || ext === 'svg') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js';
  return 'plain';
}

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

const JS_DEFS: GroupDef[] = [
  { name: 'comment', re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//, cls: 'tok-c' },
  {
    name: 'string',
    re: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/,
    cls: 'tok-s',
  },
  {
    name: 'keyword',
    re: /\b(?:const|let|var|function|return|if|else|for|while|do|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|switch|case|default|import|export|from|as|async|await|yield|static|get|set|null|undefined|true|false|void|delete)\b/,
    cls: 'tok-k',
  },
  { name: 'number', re: /\b(?:0x[\da-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/, cls: 'tok-n' },
  { name: 'call', re: /[A-Za-z_$][\w$]*(?=\s*\()/, cls: 'tok-f' },
  { name: 'prop', re: /\.[A-Za-z_$][\w$]*/, cls: 'tok-a' },
];

const CSS_DEFS: GroupDef[] = [
  { name: 'comment', re: /\/\*[\s\S]*?\*\//, cls: 'tok-c' },
  { name: 'atrule', re: /@[\w-]+/, cls: 'tok-k' },
  { name: 'string', re: /"[^"\n]*"|'[^'\n]*'/, cls: 'tok-s' },
  { name: 'selector', re: /[^{}\n]+(?=\{)/, cls: 'tok-t' },
  { name: 'property', re: /[a-zA-Z-]+(?=\s*:)/, cls: 'tok-a' },
  {
    name: 'number',
    re: /#[\da-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|svh|lvh|dvh|s|ms|deg|fr|ch|ex|vmin|vmax|cm|mm|in|pt|pc)?\b/,
    cls: 'tok-n',
  },
  { name: 'punct', re: /[{};]|!important/, cls: 'tok-p' },
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
      if (src[j] === '/') j += 1;
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
      if (j < src.length) {
        const close = src.startsWith('/>', j) ? '/>' : '>';
        push(close, 'tok-p');
        j += close.length;
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
  if (lang === 'js') return tokensToLines(runGroups(content, JS_DEFS));
  return tokensToLines([{ text: content, cls: null }]);
}
