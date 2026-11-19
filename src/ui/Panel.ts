/**
 * Tiny DOM toolkit for the control panel. Each plugin gets its own <section> and builds
 * controls with these helpers, so features stay self-contained.
 */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

export class Section {
  readonly root: HTMLElement;
  readonly body: HTMLElement;

  constructor(title: string, note?: string, open = true) {
    const details = el('details', { class: 'section', open });
    const summary = el('summary', {}, el('span', { class: 'section-title', text: title }));
    if (note) summary.append(el('span', { class: 'section-note', text: note }));
    this.body = el('div', { class: 'section-body' });
    details.append(summary, this.body);
    this.root = details;
  }

  row(...children: (Node | string)[]): HTMLElement {
    const r = el('div', { class: 'row' }, ...children);
    this.body.append(r);
    return r;
  }

  button(label: string, onClick: (btn: HTMLButtonElement) => unknown, kind: 'primary' | 'plain' = 'plain'): HTMLButtonElement {
    const b = el('button', { class: `btn ${kind}`, type: 'button', text: label });
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await onClick(b);
      } catch (err) {
        console.error(err);
        toast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const input = el('input', { type: 'checkbox' });
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    this.row(el('label', { class: 'toggle' }, input, el('span', { text: label })));
    return input;
  }

  select<T extends string>(
    label: string,
    options: { value: T; label: string }[],
    value: T,
    onChange: (v: T) => void,
  ): HTMLSelectElement {
    const sel = el('select');
    this.setOptions(sel, options, value);
    sel.addEventListener('change', () => onChange(sel.value as T));
    this.row(el('label', { class: 'field' }, el('span', { text: label }), sel));
    return sel;
  }

  setOptions(sel: HTMLSelectElement, options: { value: string; label: string }[], value?: string): void {
    sel.replaceChildren(...options.map((o) => el('option', { value: o.value, text: o.label })));
    if (value !== undefined) sel.value = value;
  }

  range(label: string, min: number, max: number, step: number, value: number, onChange: (v: number) => void): HTMLInputElement {
    const input = el('input', { type: 'range', min, max, step, value });
    const out = el('output', { text: String(value) });
    input.addEventListener('input', () => {
      out.textContent = input.value;
      onChange(Number(input.value));
    });
    this.row(el('label', { class: 'field' }, el('span', { text: label }), input, out));
    return input;
  }

  textarea(placeholder: string, value = '', rows = 3): HTMLTextAreaElement {
    const t = el('textarea', { placeholder, rows });
    t.value = value;
    this.row(t);
    return t;
  }

  text(content: string, cls = 'hint'): HTMLElement {
    const p = el('p', { class: cls, text: content });
    this.body.append(p);
    return p;
  }
}

export class Panel {
  constructor(private readonly root: HTMLElement) {}

  section(title: string, note?: string, open = true): Section {
    const s = new Section(title, note, open);
    this.root.append(s.root);
    return s;
  }
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, level: 'info' | 'warn' | 'error' = 'info', ms = 4200): void {
  toastHost ??= document.getElementById('toasts');
  if (!toastHost) return;
  const t = el('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status', text: message });
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}
