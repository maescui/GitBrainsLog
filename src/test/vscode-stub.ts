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
  /** Comandos que ha ejecutado la extensión (vscode.commands.executeCommand), con sus argumentos. */
  commands: [] as unknown[][],
  /** Archivos abiertos con window.showTextDocument, con sus opciones. */
  shown: [] as { path: string; opts: any }[],
  /** Grupos de pestañas del editor (window.tabGroups.all) y las pestañas que se han cerrado. */
  tabGroups: [] as { viewColumn: number; tabs: any[] }[],
  closedTabs: [] as unknown[],
  /** Extensiones instaladas (vscode.extensions.all): { packageJSON, extensionPath }. */
  extensions: [] as { packageJSON: any; extensionPath: string }[],
  /** Tema de color de VS Code (ColorThemeKind: 1 claro, 2 oscuro, 3 alto contraste, 4 alto contraste claro). */
  colorKind: 2,
  configListeners: [] as ((e: { affectsConfiguration(s: string): boolean }) => void)[],
  colorListeners: [] as (() => void)[],
  extensionListeners: [] as (() => void)[],
  reset() {
    this.folders = []; this.watchers = []; this.errors = []; this.warnings = []; this.infos = []; this.commands = []; this.shown = [];
    this.tabGroups = []; this.closedTabs = [];
    this.extensions = []; this.colorKind = 2; this.configListeners = []; this.colorListeners = []; this.extensionListeners = [];
  },
  /** Simula que el usuario cambia un ajuste de VS Code (p. ej. «workbench.iconTheme»). */
  changeConfig(section: string) { this.configListeners.forEach(l => l({ affectsConfiguration: s => section === s || section.startsWith(s + '.') })); },
  changeColorTheme(kind: number) { this.colorKind = kind; this.colorListeners.forEach(l => l()); },
  changeExtensions() { this.extensionListeners.forEach(l => l()); },
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

/** Registra un oyente y devuelve lo que hace falta para quitarlo (como los eventos de vscode). */
function listen<T extends (...a: any[]) => void>(list: T[], cb: T) {
  list.push(cb);
  return { dispose() { const i = list.indexOf(cb); if (i >= 0) { list.splice(i, 1); } } };
}

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
    onDidChangeConfiguration: (cb: (e: any) => void) => listen(stubState.configListeners, cb),
  },
  extensions: {
    get all() { return stubState.extensions; },
    onDidChange: (cb: () => void) => listen(stubState.extensionListeners, cb),
  },
  EventEmitter: class {
    private listeners: ((v: any) => void)[] = [];
    event = (cb: (v: any) => void) => listen(this.listeners, cb);
    fire(v?: unknown) { [...this.listeners].forEach(l => l(v)); }
  },
  Disposable: { from: (...ds: { dispose(): void }[]) => ({ dispose() { ds.forEach(d => d.dispose()); } }) },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  window: {
    get activeColorTheme() { return { kind: stubState.colorKind }; },
    onDidChangeActiveColorTheme: (cb: () => void) => listen(stubState.colorListeners, cb),
    showErrorMessage: async (m: string) => { stubState.errors.push(m); },
    showWarningMessage: async (m: string) => { stubState.warnings.push(m); },
    showInformationMessage: async (m: string) => { stubState.infos.push(m); },
    withProgress: async (_o: unknown, fn: () => Promise<unknown>) => fn(),
    showTextDocument: async (uri: { fsPath: string }, opts: unknown) => { stubState.shown.push({ path: uri.fsPath, opts }); },
    tabGroups: {
      get all() { return stubState.tabGroups; },
      onDidChangeTabs: () => ({ dispose() { /* nada */ } }),
      close: async (tab: any) => {
        stubState.closedTabs.push(tab);
        for (const g of stubState.tabGroups) { g.tabs = g.tabs.filter(t => t !== tab); }
        stubState.tabGroups = stubState.tabGroups.filter(g => g.tabs.length);
        return true;
      },
    },
  },
  TabInputWebview: class { constructor(readonly viewType: string) { /* nada */ } },
  commands: { executeCommand: async (...a: unknown[]) => { stubState.commands.push(a); } },
  ViewColumn: { One: 1, Two: 2, Active: -1, Beside: -2 },
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
