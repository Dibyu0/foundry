/**
 * Single-file site export: folds a multi-file static site into one
 * self-contained index.html by inlining local stylesheets and scripts.
 *
 * Anything that cannot be honestly embedded (images, fonts, external
 * URLs, files index.html never references) is left linked and reported
 * in `skipped` — nothing is silently dropped or rewritten.
 */

export interface BundleSkippedEntry {
  /** Site-relative path, or absolute URL for external resources. */
  path: string;
  reason: string;
}

export interface BundleResult {
  html: string;
  /** Site-relative paths whose contents were inlined into the html. */
  inlined: string[];
  skipped: BundleSkippedEntry[];
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

// Scheme (https:, data:, mailto:, ...), protocol-relative //, and pure
// #fragment references are never local files.
const EXTERNAL_REF = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const LINK_TAG = /<link\b[^>]*>/gi;
const SCRIPT_TAG = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
// Tags whose src/href embeds a resource (anchors handled separately).
const EMBED_TAG = /<(?:img|source|video|audio|iframe|embed|track)\b[^>]*>/gi;
const ANCHOR_TAG = /<a\b[^>]*>/gi;

function getAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

function hasAttr(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(?:\\s*=|\\s|>|$)`, 'i').test(tag);
}

/** The opening tag of an element match (attributes live there, not in content). */
function openTag(match: string): string {
  return /^<[a-z][a-z0-9-]*\b[^>]*>/i.exec(match)?.[0] ?? match;
}

function relTokens(tag: string): string[] {
  return (getAttr(tag, 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Normalizes a reference to a site-relative path, or returns null when the
 * reference is external, a fragment, or empty. Query strings and hashes are
 * stripped; index.html lives at the site root so resolution is lexical.
 */
function localPath(ref: string | undefined): string | null {
  if (ref === undefined) return null;
  const bare = ref.split('#')[0]?.split('?')[0]?.trim() ?? '';
  if (bare === '' || EXTERNAL_REF.test(bare)) return null;
  let p = bare.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  return p === '' ? null : p;
}

// `</style` / `</script` inside inlined content would close the host tag
// early; the backslash escape is a no-op in both CSS and JS string/comment
// contexts, so this preserves semantics exactly.
function escapeStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

function escapeScript(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}

function isValidUtf8(content: string): boolean {
  return !content.includes('�');
}

interface DeferredScript {
  path: string;
  content: string;
}

export function bundleSite(files: ReadonlyMap<string, string>): BundleResult {
  const index = files.get('index.html');
  if (index === undefined) {
    throw new BundleError('cannot bundle: site has no index.html');
  }

  const inlined: string[] = [];
  const inlinedSet = new Set<string>();
  const referenced = new Set<string>();
  const skipped: BundleSkippedEntry[] = [];
  const skippedKeys = new Set<string>();
  const deferred: DeferredScript[] = [];

  const skip = (path: string, reason: string): void => {
    const key = `${path} ${reason}`;
    if (skippedKeys.has(key)) return;
    skippedKeys.add(key);
    skipped.push({ path, reason });
  };

  const inlineContent = (path: string, kind: 'style' | 'script'): string | null => {
    const content = files.get(path);
    if (content === undefined) return null;
    if (!isValidUtf8(content)) {
      skip(path, `${kind} is not valid UTF-8; left linked`);
      return null;
    }
    return content;
  };

  let html = index.replace(LINK_TAG, (tag) => {
    const tokens = relTokens(tag);
    const href = getAttr(tag, 'href');
    const local = localPath(href);
    if (tokens.includes('stylesheet')) {
      if (local === null) {
        if (href !== undefined && !href.trimStart().startsWith('#')) {
          skip(href, 'external stylesheet; stays linked');
        }
        return tag;
      }
      referenced.add(local);
      if (inlinedSet.has(local)) return tag;
      const content = inlineContent(local, 'style');
      if (content === null) {
        if (!files.has(local)) skip(local, 'referenced stylesheet not found in site files; left linked');
        return tag;
      }
      inlined.push(local);
      inlinedSet.add(local);
      return `<style data-inlined-from="${local}">\n${escapeStyle(content)}\n</style>`;
    }
    // Icons, manifests, preloads, font links: embedded resources we do not inline.
    if (local !== null) {
      referenced.add(local);
      if (!inlinedSet.has(local)) skip(local, 'linked resource; left linked (not embedded)');
    } else if (href !== undefined && tokens.some((t) => ['icon', 'apple-touch-icon', 'manifest', 'preload', 'font'].includes(t))) {
      skip(href, 'external resource; stays linked');
    }
    return tag;
  });

  html = html.replace(SCRIPT_TAG, (tag) => {
    const open = openTag(tag);
    const src = getAttr(open, 'src');
    if (src === undefined) return tag; // already inline
    const local = localPath(src);
    if (local === null) {
      skip(src, 'external script; stays linked');
      return tag;
    }
    referenced.add(local);
    if (inlinedSet.has(local)) return tag;
    const content = inlineContent(local, 'script');
    if (content === null) {
      if (!files.has(local)) skip(local, 'referenced script not found in site files; left linked');
      return tag;
    }
    inlined.push(local);
    inlinedSet.add(local);
    const block = `<script data-inlined-from="${local}">\n${escapeScript(content)}\n</script>`;
    // defer on an inline script is ignored by browsers, so a deferred
    // script inlined in place would run too early. Deferred scripts are
    // moved to just before </body>, preserving after-parse execution order.
    if (hasAttr(open, 'defer') || hasAttr(open, 'async')) {
      deferred.push({ path: local, content: block });
      return '';
    }
    return block;
  });

  if (deferred.length > 0) {
    const insertion = deferred.map((d) => d.content).join('\n');
    const bodyClose = /<\/body\s*>/i.exec(html);
    if (bodyClose) {
      html = `${html.slice(0, bodyClose.index)}${insertion}\n${html.slice(bodyClose.index)}`;
    } else {
      html = `${html}\n${insertion}\n`;
    }
  }

  // Assets referenced from inlined CSS keep their relative URLs; the files
  // are not embedded, so report them.
  for (const path of inlined) {
    const content = files.get(path);
    if (content === undefined || !path.endsWith('.css')) continue;
    CSS_URL.lastIndex = 0;
    for (let m = CSS_URL.exec(content); m !== null; m = CSS_URL.exec(content)) {
      const ref = (m[1] ?? m[2] ?? m[3] ?? '').trim();
      if (ref === '' || /^data:/i.test(ref) || ref.startsWith('#')) continue;
      const local = localPath(ref);
      if (local !== null) {
        referenced.add(local);
        if (!inlinedSet.has(local)) skip(local, 'asset referenced from inlined CSS; left linked (not embedded)');
      } else {
        skip(ref, 'external asset referenced from inlined CSS; stays linked');
      }
    }
  }

  // Remaining embedded resources in the markup (images, media, frames).
  EMBED_TAG.lastIndex = 0;
  for (let m = EMBED_TAG.exec(html); m !== null; m = EMBED_TAG.exec(html)) {
    const tag = m[0];
    const refs: string[] = [];
    const src = getAttr(tag, 'src');
    if (src !== undefined) refs.push(src);
    const srcset = getAttr(tag, 'srcset');
    if (srcset !== undefined) {
      for (const candidate of srcset.split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (url) refs.push(url);
      }
    }
    for (const ref of refs) {
      if (ref === '' || /^data:/i.test(ref) || ref.startsWith('#')) continue;
      const local = localPath(ref);
      if (local !== null) {
        referenced.add(local);
        if (!inlinedSet.has(local)) skip(local, 'embedded resource; left linked (not embedded)');
      } else if (EXTERNAL_REF.test(ref)) {
        skip(ref, 'external embedded resource; stays linked');
      }
    }
  }

  // Local pages linked from anchors are not part of the single file.
  ANCHOR_TAG.lastIndex = 0;
  for (let m = ANCHOR_TAG.exec(html); m !== null; m = ANCHOR_TAG.exec(html)) {
    const local = localPath(getAttr(m[0], 'href'));
    if (local === null) continue;
    referenced.add(local);
    if (!inlinedSet.has(local)) skip(local, 'linked from index.html; not included in single-file export');
  }

  // Anything left in the site that index.html never reaches is omitted.
  for (const path of [...files.keys()].sort()) {
    if (path === 'index.html' || inlinedSet.has(path) || referenced.has(path)) continue;
    skip(path, 'not referenced by index.html; omitted from single-file export');
  }

  return { html, inlined, skipped };
}
