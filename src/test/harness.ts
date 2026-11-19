/**
 * Harness de integración: crea el `GitLogViewProvider` real contra repos git temporales, con un
 * panel (webview) y un contexto de extensión falsos, y lo maneja como lo haría el webview:
 * se le mandan mensajes y se leen los que contesta. Dentro de VS Code solo cambia la capa de
 * `vscode`, que aquí es el stub (vscode-stub.ts); lo demás —git, refresh, auto-stage, watchers—
 * es el código de producción.
 *
 * Las esperas son por condición (`waitFor`), no por tiempo, para que los tests no sean intermitentes.
 */
import { stubState, stubConfig } from './vscode-stub';   // el stub va primero: instala el módulo «vscode»
import * as path from 'path';
import { GitLogViewProvider } from '../extension';

export { stubState, stubConfig };

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Memento (workspaceState / globalState) en memoria. */
class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string, def?: T): T { return (this.data.has(key) ? this.data.get(key) : def) as T; }
  async update(key: string, value: unknown) { if (value === undefined) { this.data.delete(key); } else { this.data.set(key, value); } }
  keys() { return [...this.data.keys()]; }
}

export type Msg = { type: string; [k: string]: any };

export interface Panel {
  provider: any;
  /** Todo lo que la extensión ha mandado al webview, en orden. */
  posted: Msg[];
  /** Manda un mensaje como si lo enviara el webview. */
  send(m: Msg): Promise<unknown>;
  /** Espera a un mensaje de ese tipo (que cumpla `pred`) posterior a `from` (por defecto, desde ahora). */
  waitFor(type: string, opts?: { pred?: (m: Msg) => boolean; from?: number; timeout?: number }): Promise<Msg>;
  /** Mensajes de un tipo posteriores a la posición `from`. */
  since(type: string, from: number): Msg[];
  /** Los repos de la extensión (para espiar su `git`). */
  repos(): any[];
  dispose(): void;
}

/** Abre el panel sobre estas carpetas del workspace y espera a que cargue el log y los cambios. */
export async function openPanel(folders: string[], opts: { wait?: boolean } = {}): Promise<Panel> {
  stubState.reset();
  stubState.folders = folders;
  const ROOT = path.join(__dirname, '..', '..');
  const context: any = {
    extensionUri: { fsPath: ROOT, path: ROOT, scheme: 'file' },
    workspaceState: new FakeMemento(), globalState: new FakeMemento(), subscriptions: [],
  };
  const provider: any = new GitLogViewProvider(context);

  const posted: Msg[] = [];
  const waiters: (() => void)[] = [];
  let onMessage: ((m: Msg) => unknown) | undefined;
  const view: any = {
    visible: true, description: undefined,
    webview: {
      options: {}, html: '', cspSource: 'stub', asWebviewUri: (u: unknown) => u,
      postMessage: (m: Msg) => { posted.push(m); waiters.splice(0).forEach(w => w()); return Promise.resolve(true); },
      onDidReceiveMessage: (cb: (m: Msg) => unknown) => { onMessage = cb; return { dispose() { /* nada */ } }; },
    },
    onDidChangeVisibility: () => ({ dispose() { /* nada */ } }),
    onDidDispose: () => ({ dispose() { /* nada */ } }),
    show: () => undefined,
  };
  provider.resolveWebviewView(view);

  const waitFor: Panel['waitFor'] = (type, o = {}) => new Promise((resolve, reject) => {
    const from = o.from ?? posted.length;
    const timer = setTimeout(() => reject(new Error(`Timeout esperando '${type}' (llegaron: ${posted.slice(from).map(m => m.type).join(', ') || 'nada'})`)), o.timeout ?? 10000);
    const check = () => {
      const m = posted.slice(from).find(x => x.type === type && (!o.pred || o.pred(x)));
      if (m) { clearTimeout(timer); resolve(m); } else { waiters.push(check); }
    };
    check();
  });

  const panel: Panel = {
    provider, posted,
    send: async m => onMessage?.(m),
    waitFor,
    since: (type, from) => posted.slice(from).filter(m => m.type === type),
    repos: () => provider.repos,
    dispose() {
      clearTimeout(provider.refreshTimer); clearTimeout(provider.changesTimer);
      provider.dispose();
    },
  };

  if (opts.wait !== false) {
    // 'ready' arranca refresh(): llegan el log, los cambios y los stashes
    const first = waitFor('data'), changes = waitFor('changes'), stashes = waitFor('stashes');
    await panel.send({ type: 'ready' });
    await Promise.all([first, changes, stashes]);
  }
  return panel;
}

/**
 * Envuelve un método de `Git` de un repo: `wrap(original, ...args)` decide qué hacer. Devuelve
 * la función que lo deja como estaba.
 */
export function spyGit(git: any, method: string, wrap: (orig: (...a: any[]) => Promise<any>, ...a: any[]) => Promise<any>): () => void {
  const orig = git[method].bind(git);
  git[method] = (...a: any[]) => wrap(orig, ...a);
  return () => { delete git[method]; };
}

/** Espera a que se cumpla una condición (sondea cada 10 ms). */
export async function until(cond: () => boolean, what: string, timeout = 10000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) { throw new Error(`Timeout esperando: ${what}`); }
    await sleep(10);
  }
}
