/**
 * Serve-time preview bridge injection.
 *
 * INJECT_SCRIPT is a self-contained <script> tag spliced into HTML responses
 * by the preview route. It wires the generated site's iframe to the Foundry
 * app: console/error/network capture, element inspection, and visual style
 * edits. It runs as-is in the browser (no build step, no dependencies), so it
 * must stay ASCII-only and must never contain the literal "</script>" or the
 * character sequence "${" anywhere inside the JS body.
 *
 * The wire protocol is shared with web/src/previewBridge.ts — keep the message
 * shapes in sync with that file:
 *   child -> parent: { source: 'foundry-preview', kind: 'console' | 'error' |
 *     'network' | 'ready' | 'buffer' | 'inspect-hover' | 'inspect-select' |
 *     'inspect-state' | 'style-applied', ... }
 *   parent -> child: { source: 'foundry-app', kind: 'foundry:inspect' |
 *     'foundry:applyStyle' | 'foundry:pull', ... }
 * Inspection payloads carry a CSS `selector` (nth-of-type path) so the parent
 * can round-trip 'foundry:applyStyle' edits against the same element; `xpath`
 * is the human-readable twin. prop 'text' in applyStyle edits textContent.
 */

const BRIDGE_MARKER = 'foundry-preview-bridge';

const BRIDGE_JS = String.raw`
(function () {
  'use strict';
  if (window.__foundryPreviewBridge) return;
  window.__foundryPreviewBridge = { version: 1 };

  var inFrame = window.parent !== window;
  var BUFFER_LIMIT = 200;
  var buffer = [];

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max) + '...' : text;
  }

  function stringify(value) {
    if (value === null) return 'null';
    var type = typeof value;
    if (type === 'string') return value;
    if (type === 'number' || type === 'boolean') return String(value);
    if (type === 'undefined') return 'undefined';
    if (type === 'bigint') return String(value) + 'n';
    if (type === 'symbol') return value.toString();
    if (type === 'function') return '[function ' + (value.name || 'anonymous') + ']';
    if (value instanceof Error) {
      return value.name + ': ' + value.message + (value.stack ? '\n' + value.stack : '');
    }
    try {
      var seen = [];
      return JSON.stringify(value, function (key, val) {
        if (typeof val === 'object' && val !== null) {
          if (seen.indexOf(val) !== -1) return '[circular]';
          seen.push(val);
        }
        if (val instanceof Error) return val.name + ': ' + val.message;
        if (typeof val === 'bigint') return String(val) + 'n';
        if (typeof val === 'function') return '[function]';
        return val;
      });
    } catch (err) {
      return Object.prototype.toString.call(value);
    }
  }

  function post(message) {
    if (!inFrame) return;
    try {
      window.parent.postMessage(message, '*');
    } catch (err) {
      // Parent frame is gone or mid-navigation; nothing else we can do.
    }
  }

  function record(kind, fields) {
    var entry = { source: 'foundry-preview', kind: kind, ts: Date.now() };
    for (var key in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) entry[key] = fields[key];
    }
    buffer.push(entry);
    if (buffer.length > BUFFER_LIMIT) buffer.shift();
    post(entry);
  }

  // --- console.capture -------------------------------------------------------

  ['log', 'warn', 'error'].forEach(function (level) {
    var original = console[level];
    if (typeof original !== 'function') return;
    console[level] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(stringify(arguments[i]));
        record('console', { level: level, text: truncate(parts.join(' '), 1000) });
      } catch (err) {
        // Capturing must never break the page's own console.
      }
      return original.apply(console, arguments);
    };
  });

  window.addEventListener('error', function (event) {
    try {
      var target = event.target;
      if (target && target !== window && target !== document) {
        // Resource load failure (img/script/link/stylesheet): no message is
        // available, so report it as a failed network entry instead.
        var resourceUrl = target.src || target.href || '';
        if (resourceUrl) {
          record('network', {
            method: 'GET', url: String(resourceUrl), ok: false, status: 0,
            error: 'resource failed to load', via: 'resource'
          });
        }
        return;
      }
      record('error', {
        message: truncate(String(event.message || 'unknown error'), 500),
        file: event.filename || undefined,
        line: typeof event.lineno === 'number' ? event.lineno : undefined,
        col: typeof event.colno === 'number' ? event.colno : undefined,
        stack: event.error && event.error.stack ? truncate(String(event.error.stack), 2000) : undefined
      });
    } catch (err) { /* capture must never throw back into the page */ }
  }, true);

  window.addEventListener('unhandledrejection', function (event) {
    try {
      var reason = event.reason;
      record('error', {
        message: truncate('unhandled rejection: ' + stringify(reason), 500),
        stack: reason && reason.stack ? truncate(String(reason.stack), 2000) : undefined
      });
    } catch (err) { /* ignore */ }
  });

  // --- network capture -------------------------------------------------------

  if (typeof window.fetch === 'function') {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var started = Date.now();
      var method = 'GET';
      var url = '';
      try {
        url = typeof input === 'string' ? input : (input && input.url ? String(input.url) : '');
        method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      } catch (err) { /* ignore */ }
      return originalFetch.apply(this, arguments).then(
        function (response) {
          try {
            if (!response.ok) {
              record('network', {
                method: method, url: url, status: response.status, ok: false,
                durationMs: Date.now() - started, via: 'fetch'
              });
            }
          } catch (err) { /* ignore */ }
          return response;
        },
        function (err) {
          try {
            record('network', {
              method: method, url: url, ok: false, durationMs: Date.now() - started,
              error: truncate(stringify(err), 300), via: 'fetch'
            });
          } catch (ignored) { /* ignore */ }
          throw err;
        }
      );
    };
  }

  var xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto) {
    var originalOpen = xhrProto.open;
    var originalSend = xhrProto.send;
    xhrProto.open = function (method, url) {
      if (!this.__foundryNetHooked) {
        this.__foundryNetHooked = true;
        this.addEventListener('loadend', function () {
          try {
            var meta = this.__foundryNet;
            if (meta && (this.status === 0 || this.status >= 400)) {
              record('network', {
                method: meta.method, url: meta.url, status: this.status, ok: false,
                durationMs: Date.now() - meta.started, via: 'xhr'
              });
            }
          } catch (err) { /* ignore */ }
        });
        this.addEventListener('error', function () {
          try {
            var meta = this.__foundryNet;
            if (meta) {
              record('network', {
                method: meta.method, url: meta.url, status: 0, ok: false,
                error: 'xhr error', durationMs: Date.now() - meta.started, via: 'xhr'
              });
            }
          } catch (err) { /* ignore */ }
        });
        this.addEventListener('timeout', function () {
          try {
            var meta = this.__foundryNet;
            if (meta) {
              record('network', {
                method: meta.method, url: meta.url, status: 0, ok: false,
                error: 'xhr timeout', durationMs: Date.now() - meta.started, via: 'xhr'
              });
            }
          } catch (err) { /* ignore */ }
        });
      }
      this.__foundryNet = {
        method: String(method || 'GET').toUpperCase(),
        url: String(url || ''),
        started: 0
      };
      return originalOpen.apply(this, arguments);
    };
    xhrProto.send = function () {
      if (this.__foundryNet) this.__foundryNet.started = Date.now();
      return originalSend.apply(this, arguments);
    };
  }

  if (typeof window.PerformanceObserver === 'function') {
    try {
      var observer = new PerformanceObserver(function (list) {
        try {
          var entries = list.getEntries();
          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.entryType !== 'resource') continue;
            record('network', {
              method: 'GET', url: String(entry.name || ''), ok: true,
              durationMs: Math.round(entry.duration || 0),
              initiator: entry.initiatorType || undefined, via: 'performance'
            });
          }
        } catch (err) { /* ignore */ }
      });
      try {
        observer.observe({ type: 'resource', buffered: true });
      } catch (err) {
        observer.observe({ entryTypes: ['resource'] });
      }
    } catch (err) { /* resource timing unsupported */ }
  }

  // --- element inspection ----------------------------------------------------

  var STYLE_PROPS = ['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'margin', 'padding', 'borderRadius'];
  var inspecting = false;
  var overlay = null;
  var hovered = null;

  function ensureOverlay() {
    if (overlay && overlay.parentNode) return overlay;
    var el = document.createElement('div');
    el.setAttribute('data-foundry-inspect-overlay', '');
    el.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;' +
      'z-index:2147483647;border:2px solid #7c5cff;background:rgba(124,92,255,0.08);' +
      'box-sizing:border-box;display:none;';
    (document.body || document.documentElement).appendChild(el);
    overlay = el;
    return el;
  }

  function xpathLite(el) {
    var segments = [];
    var node = el;
    while (node && node.nodeType === 1 && segments.length < 12) {
      if (node.id) {
        segments.unshift('#' + node.id);
        break;
      }
      var index = 1;
      var sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(node.tagName.toLowerCase() + '[' + index + ']');
      node = node.parentElement;
    }
    return '/' + segments.join('/');
  }

  function escapeIdent(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^A-Za-z0-9_-]/g, function (ch) { return '\\' + ch; });
  }

  // A valid CSS selector path (nth-of-type chain, #id short-circuit) so the
  // parent can round-trip applyStyle edits against the inspected element.
  function cssPathLite(el) {
    var segments = [];
    var node = el;
    while (node && node.nodeType === 1 && segments.length < 12) {
      if (node.id) {
        segments.unshift('#' + escapeIdent(node.id));
        break;
      }
      var tag = node.tagName.toLowerCase();
      if (!node.parentElement) {
        segments.unshift(tag);
        break;
      }
      var index = 1;
      var sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(tag + ':nth-of-type(' + index + ')');
      node = node.parentElement;
    }
    return segments.join('>');
  }

  function describeElement(el) {
    var computed = window.getComputedStyle(el);
    var styles = {};
    for (var i = 0; i < STYLE_PROPS.length; i++) {
      var prop = STYLE_PROPS[i];
      styles[prop] = computed[prop] || '';
    }
    var className = typeof el.className === 'string' ? el.className : '';
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: className.split(/\s+/).filter(Boolean),
      text: truncate((el.textContent || '').replace(/\s+/g, ' ').trim(), 80),
      styles: styles,
      xpath: xpathLite(el),
      selector: cssPathLite(el)
    };
  }

  function highlight(el) {
    hovered = el;
    var box = ensureOverlay();
    if (!el) {
      box.style.display = 'none';
      return;
    }
    var rect = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.top = rect.top + 'px';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
  }

  function setInspecting(next) {
    if (next === inspecting) return;
    inspecting = next;
    if (next) {
      ensureOverlay();
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);
    } else {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      highlight(null);
      hovered = null;
      lastHoverPosted = null;
    }
    post({ source: 'foundry-preview', kind: 'inspect-state', armed: inspecting, ts: Date.now() });
  }

  function inspectTarget(event) {
    var target = event.target;
    if (!target || target.nodeType !== 1 || target === overlay) return null;
    return target;
  }

  var lastHoverPosted = null;

  function onMouseMove(event) {
    var target = inspectTarget(event);
    if (!target) return;
    highlight(target);
    // Stream hovers only when the element under the cursor changes, so the
    // parent panel can mirror the highlight without a postMessage flood.
    if (target !== lastHoverPosted) {
      lastHoverPosted = target;
      post({ source: 'foundry-preview', kind: 'inspect-hover', element: describeElement(target), ts: Date.now() });
    }
  }

  function onClick(event) {
    var target = inspectTarget(event);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    var element = describeElement(target);
    post({ source: 'foundry-preview', kind: 'inspect-select', element: element, ts: Date.now() });
    setInspecting(false);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') setInspecting(false);
  }

  function onScroll() {
    if (inspecting && hovered) highlight(hovered);
  }

  // --- visual style edits ----------------------------------------------------

  function applyStyle(message) {
    var selector = String(message.selector || '');
    var prop = String(message.prop || '');
    var value = String(message.value || '');
    var reply = {
      source: 'foundry-preview', kind: 'style-applied', ts: Date.now(),
      selector: selector, prop: prop, value: value, requestId: message.requestId
    };
    if (!selector || !prop) {
      reply.ok = false;
      reply.error = 'selector and prop are required';
      post(reply);
      return;
    }
    var el = null;
    try {
      el = document.querySelector(selector);
    } catch (err) {
      reply.ok = false;
      reply.error = 'invalid selector: ' + String(err && err.message ? err.message : err);
      post(reply);
      return;
    }
    if (!el) {
      reply.ok = false;
      reply.error = 'no element matches selector';
      post(reply);
      return;
    }
    try {
      if (prop === 'text') {
        el.textContent = value;
        reply.ok = true;
        reply.applied = truncate((el.textContent || '').replace(/\s+/g, ' ').trim(), 80);
      } else if (prop.indexOf('-') !== -1) {
        el.style.setProperty(prop, value);
        reply.ok = true;
        reply.applied = el.style.getPropertyValue(prop);
      } else {
        el.style[prop] = value;
        reply.ok = true;
        reply.applied = String(el.style[prop] || '');
      }
    } catch (err) {
      reply.ok = false;
      reply.error = String(err && err.message ? err.message : err);
    }
    post(reply);
  }

  // --- command channel -------------------------------------------------------

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.source !== 'foundry-app') return;
    try {
      if (message.kind === 'foundry:inspect') {
        setInspecting(message.armed !== false);
      } else if (message.kind === 'foundry:applyStyle') {
        applyStyle(message);
      } else if (message.kind === 'foundry:pull') {
        post({ source: 'foundry-preview', kind: 'buffer', entries: buffer.slice(), ts: Date.now() });
      }
    } catch (err) { /* never throw back into the page */ }
  });

  post({ source: 'foundry-preview', kind: 'ready', href: String(window.location.href), ts: Date.now() });
})();
`;

export const INJECT_SCRIPT = `<script id="${BRIDGE_MARKER}" data-foundry-bridge="1">${BRIDGE_JS}</script>`;

export interface InjectOptions {
  /**
   * Content-Type of the response being served. Injection only applies to HTML;
   * anything else is returned byte-identical.
   */
  contentType?: string;
}

const HTML_TYPE = /^(?:text\/html|application\/xhtml\+xml)\b/i;
const BODY_CLOSE = /<\/body\s*>/i;

/**
 * Splice INJECT_SCRIPT into an HTML document, immediately before `</body>`
 * (appended at the end when the document has no body tag — browsers still run
 * it). Idempotent: a document that already carries the bridge marker is
 * returned unchanged. Non-HTML content types pass through unchanged. This is
 * serve-time only: files on disk are never modified, so downloads stay clean.
 */
export function injectBridge(html: string, options: InjectOptions = {}): string {
  const { contentType = 'text/html' } = options;
  if (!HTML_TYPE.test(contentType)) return html;
  if (html.includes(BRIDGE_MARKER)) return html;
  const close = BODY_CLOSE.exec(html);
  if (close) {
    return html.slice(0, close.index) + INJECT_SCRIPT + html.slice(close.index);
  }
  return html + INJECT_SCRIPT;
}
