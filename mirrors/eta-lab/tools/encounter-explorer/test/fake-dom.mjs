// A tiny DOM for node tests of the layer registry: just what dom.js's h() touches. Text is read back with textOf / find.
class Text { constructor(s) { this.nodeType = 3; this.textContent = String(s); } }
class El {
  constructor(tag) { this.nodeType = 1; this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ""; this._text = null; this.hidden = false; this.style = { setProperty() {} }; }
  append(...k) { for (const c of k) this.children.push(c.nodeType ? c : new Text(c)); }
  replaceChildren(...k) { this.children = []; this._text = null; this.append(...k); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text !== null ? this._text : this.children.map(c => c.textContent).join(""); }
}
export function installFakeDom() { globalThis.document = { createElement: t => new El(t), createTextNode: s => new Text(s) }; }
export const textOf = n => n.textContent;
/** every element under n (and n) for which pred is true */
export function find(n, pred, out = []) { if (n && n.nodeType === 1) { if (pred(n)) out.push(n); for (const c of n.children) find(c, pred, out); } return out; }
export const hasClass = (n, c) => (" " + n.className + " ").includes(" " + c + " ");
