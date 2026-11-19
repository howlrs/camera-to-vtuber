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

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'warn' | 'failed';

const STEP_MARK: Record<StepState, string> = { pending: '○', running: '●', done: '✓', skipped: '－', warn: '!', failed: '✕' };
const STEP_STATE: Record<StepState, string> = { pending: '待機', running: '実行中', done: '完了', skipped: '省略', warn: '一部失敗', failed: '失敗' };

/**
 * Checklist for a multi-step job: each step shows pending / running / done, and a summary line
 * counts the elapsed seconds while running, then states clearly whether the job finished or failed.
 */
export class Progress {
  readonly root: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly summary: HTMLElement;
  private readonly items = new Map<string, { li: HTMLLIElement; label: string; state: StepState; detail: string }>();
  private started = 0;
  private timer = 0;

  constructor() {
    this.list = el('ol', { class: 'steps' });
    this.summary = el('p', { class: 'progress-summary', role: 'status', 'aria-live': 'polite' });
    this.root = el('div', { class: 'progress', hidden: true }, this.summary, this.list);
  }

  /** Reset to the given steps (all pending) and start the elapsed-time counter. */
  begin(steps: { id: string; label: string }[]): void {
    this.stopTimer();
    this.items.clear();
    this.list.replaceChildren(
      ...steps.map((s) => {
        const li = el('li');
        this.items.set(s.id, { li, label: s.label, state: 'pending', detail: '' });
        return li;
      }),
    );
    for (const s of steps) this.set(s.id, 'pending');
    this.root.hidden = false;
    this.root.dataset.state = 'running';
    this.started = performance.now();
    const tick = () => (this.summary.textContent = `実行中…（${this.elapsed()} 秒）`);
    tick();
    this.timer = window.setInterval(tick, 1000);
  }

  /** Update a step; `detail` is appended to its label (e.g. "3/4 枚"). */
  set(id: string, state: StepState, detail = ''): void {
    const item = this.items.get(id);
    if (!item) return;
    item.state = state;
    item.detail = detail;
    item.li.dataset.state = state;
    item.li.replaceChildren(
      el('span', { class: 'mark', 'aria-hidden': 'true', text: STEP_MARK[state] }),
      el('span', { text: `${item.label}${detail ? `（${detail}）` : ''}` }),
      el('span', { class: 'visually-hidden', text: `: ${STEP_STATE[state]}` }),
    );
  }

  /**
   * Stop the counter and show the outcome ("✓ message（12 秒）。note"). A step still running when
   * the job fails is marked failed. Returns the elapsed seconds.
   */
  finish(ok: boolean, message: string, note = ''): number {
    this.stopTimer();
    const secs = this.elapsed();
    if (!ok) for (const [id, { li }] of this.items) if (li.dataset.state === 'running') this.set(id, 'failed');
    this.root.dataset.state = ok ? 'done' : 'failed';
    this.summary.textContent = `${ok ? '✓' : '✕'} ${message}（${secs} 秒）${note ? `。${note}` : ''}`;
    return secs;
  }

  hide(): void {
    this.stopTimer();
    this.root.hidden = true;
  }

  /** Final state of each step, for the run log. */
  steps(): { id: string; state: StepState; detail: string }[] {
    return [...this.items].map(([id, { state, detail }]) => ({ id, state, detail }));
  }

  private elapsed(): number {
    return Math.round((performance.now() - this.started) / 1000);
  }

  private stopTimer(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, level: 'info' | 'success' | 'warn' | 'error' = 'info', ms = 4200): void {
  toastHost ??= document.getElementById('toasts');
  if (!toastHost) return;
  const t = el('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status', text: message });
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}
