/**
 * Sustituto mínimo del módulo «vscode» para los tests (node --test no corre dentro de VS
 * Code). Basta con importarlo antes que un módulo que haga `import * as vscode from 'vscode'`
 * (p. ej. merge.ts) para poder probar su lógica pura. La configuración devuelve siempre el
 * valor por defecto, salvo lo que se ponga en `stubConfig`. `stubState` deja a los tests de
 * integración (harness.ts) fijar las carpetas del workspace, ver los watchers que registra la
 * extensión y dispararlos, y leer los avisos que muestra.
 */
import Module = require('module');

export const stubConfig: Record<string, unknown> = {};

type Handler = (u: { fsPath: string }) => void;
export interface StubWatcher {
  base: string; pattern: string; disposed: boolean;
  handlers: { change: Handler[]; create: Handler[]; delete: Handler[] };
}

/** Estado del stub que los tests pueden leer y cambiar. */
export const stubState = {
  folders: [] as string[],
  watchers: [] as StubWatcher[],
  errors: [] as string[],
  warnings: [] as string[],
  infos: [] as string[],
  reset() { this.folders = []; this.watchers = []; this.errors = []; this.warnings = []; this.infos = []; },
  /** Dispara un evento en todos los watchers vivos con esa base y ese patrón (fsPath = el archivo que cambia). */
  fire(kind: 'change' | 'create' | 'delete', where: { base: string; pattern?: string }, fsPath: string) {
    const norm = (x: string) => x.replace(/\\/g, '/').toLowerCase();
    const hit = this.watchers.filter(w => !w.disposed && norm(w.base) === norm(where.base) && (where.pattern === undefined || w.pattern === where.pattern));
    for (const w of hit) { w.handlers[kind].forEach(h => h({ fsPath })); }
    return hit.length;
  },
};

class StubRelativePattern {
  readonly base: string;
  constructor(base: string | { fsPath: string }, readonly pattern: string) { this.base = typeof base === 'string' ? base : base.fsPath; }
}

const noop = async () => undefined;

const stub: any = {
  Uri: {
    file: (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }),
    from: (o: Record<string, string>) => ({ ...o, toString: () => `${o.scheme}:${o.path}?${o.query ?? ''}` }),
    joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }),
  },
  RelativePattern: StubRelativePattern,
  workspace: {
    get workspaceFolders() { return stubState.folders.length ? stubState.folders.map(f => ({ uri: stub.Uri.file(f), name: f })) : undefined; },
    createFileSystemWatcher: (pat: StubRelativePattern) => {
      const w: StubWatcher = { base: pat.base, pattern: pat.pattern, disposed: false, handlers: { change: [], create: [], delete: [] } };
      stubState.watchers.push(w);
      const on = (list: Handler[]) => (h: Handler) => { list.push(h); return { dispose() { /* nada */ } }; };
      return {
        onDidChange: on(w.handlers.change), onDidCreate: on(w.handlers.create), onDidDelete: on(w.handlers.delete),
        dispose() { w.disposed = true; },
      };
    },
    getConfiguration: () => ({
      get: <T>(key: string, def: T): T => (key in stubConfig ? stubConfig[key] as T : def),
      update: async () => undefined,
    }),
  },
  window: {
    showErrorMessage: async (m: string) => { stubState.errors.push(m); },
    showWarningMessage: async (m: string) => { stubState.warnings.push(m); },
    showInformationMessage: async (m: string) => { stubState.infos.push(m); },
    withProgress: async (_o: unknown, fn: () => Promise<unknown>) => fn(),
  },
  commands: { executeCommand: noop },
  ViewColumn: { One: 1, Active: -1, Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { Notification: 15 },
};

const mod = Module as unknown as { _load: (req: string, parent: unknown, isMain: boolean) => unknown };
const original = mod._load;
mod._load = function (req: string, parent: unknown, isMain: boolean) {
  if (req === 'vscode') { return stub; }
  return original.call(this, req, parent, isMain);
};
