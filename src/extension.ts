import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
  Git, Ref, FileChange, RepoOperation, LocalChange, StashFile, LogFilters, EMPTY_FILTERS, LogCommit,
  splitRemoteRef, parseDiffBlocks, buildBlockPatch, findRepositories,
} from './git';
import { computeGraph, GraphColor } from './graph';
import { ComparePanel } from './compare';
import { MergePanel } from './merge';
import { DialogWindow } from './dialog';
import { fontAttrs, fontSettings } from './fonts';
import {
  scanDepth, commitsPerPage, mergeArgs, autoBranchColor, DEFAULT_FOLDER_COLORS, validateSetting, mergeLogs,
  samePath, pathInside, safeRepoPath, SerialQueue, Generation, watchSpecs,
} from './core';

const SCHEME = 'jbgit';

export function activate(context: vscode.ExtensionContext) {
  const provider = new GitLogViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GitLogViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider()),
    vscode.commands.registerCommand('jbGit.refresh', () => provider.init()),
    vscode.commands.registerCommand('jbGit.focus', () => vscode.commands.executeCommand('jbGit.log.focus')),
    vscode.commands.registerCommand('jbGit.showHistory', (uri?: vscode.Uri) => provider.showHistoryForUri(uri)),
    vscode.commands.registerCommand('jbGit.openFile', (uri: vscode.Uri) => openWorkingCopy(uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.init()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('jbGit')) { provider.postSettings(); }
      if (e.affectsConfiguration('jbGit.repositoryScanMaxDepth')) { provider.init(); }
      else if (e.affectsConfiguration('jbGit')) { provider.refresh(); }
    }),
    provider
  );
}

export function deactivate() { /* nada */ }

// ---------------------------------------------------------------------------
// Contenido de archivos en una revisión: jbgit:/ruta/archivo.ts?{"ref":"abc","root":"/repo"}
// ---------------------------------------------------------------------------

function revisionUri(root: string, ref: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + relPath, query: JSON.stringify({ ref, root }) });
}

/** Abre el archivo del árbol de trabajo (rel dentro de root); avisa si ya no existe. */
async function showWorkingFile(root: string, rel: string) {
  const abs = safeRepoPath(root, rel);
  if (!abs) { return; }
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
  } catch {
    vscode.window.showWarningMessage(`${rel} doesn't exist in the working tree.`);
  }
}

/** Botón «Open File» de la pestaña de diff de una revisión (uri: el lado derecho, jbgit:). */
function openWorkingCopy(uri: vscode.Uri) {
  try {
    return showWorkingFile((JSON.parse(uri.query) as { root: string }).root, uri.path.replace(/^\//, ''));
  } catch { /* uri sin el formato de revisionUri */ }
}

class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { ref, root } = JSON.parse(uri.query) as { ref: string; root: string };
    if (!ref) { return ''; }
    try {
      return await new Git(root).run(['show', `${ref}:${uri.path.replace(/^\//, '')}`]);
    } catch {
      return '';
    }
  }
}

// ---------------------------------------------------------------------------
// Un repositorio del workspace y su estado
// ---------------------------------------------------------------------------

/**
 * La carpeta abierta puede contener varios repositorios y todas las pestañas los
 * muestran a la vez. Cada uno guarda aquí su estado. Los commits viajan al webview
 * como «idx:hash» para que dos clones del mismo proyecto no se confundan.
 */
class Repo {
  readonly git: Git;
  readonly name: string;
  head = { hash: '', branch: '' };
  refs: Ref[] = [];
  remotes: string[] = [];
  me = '';
  /** Rebase, merge, cherry-pick o revert a medias (barra de aviso con Continue / Abort). */
  op: RepoOperation | null = null;
  watchers: vscode.Disposable[] = [];
  /** Tags del remoto por defecto (null = aún no se sabe o no se pudo consultar). */
  remoteTags: Set<string> | null = null;
  /** Hay que volver a consultar los tags del remoto (al abrir y tras fetch, pull o push). */
  remoteTagsStale = true;
  remoteTagsLoading = false;

  constructor(readonly idx: number, readonly root: string) {
    this.git = new Git(root);
    this.name = path.basename(root);
  }

  async load() {
    this.remotes = await this.git.getRemotes();
    const [refs, head] = await Promise.all([this.git.getRefs(this.remotes), this.git.getHead()]);
    this.refs = refs;
    this.head = head;
    this.op = await this.git.getOperation().catch(() => null);
    if (!this.me) { this.me = (await this.git.run(['config', 'user.name']).catch(() => '')).trim(); }
  }

  /** Tag local que no está en el remoto por defecto (undefined si no se sabe). */
  tagUnpushed(name: string): boolean | undefined {
    return this.remoteTags ? !this.remoteTags.has(name) : undefined;
  }

  defaultRemote(): string | undefined {
    return this.remotes.includes('origin') ? 'origin' : this.remotes[0];
  }

  currentRef(): Ref | undefined {
    return this.refs.find(r => r.type === 'local' && r.name === this.head.branch);
  }

  id(hash: string) { return `${this.idx}:${hash}`; }

  disposed = false;
  dispose() { this.disposed = true; this.watchers.forEach(w => w.dispose()); this.watchers = []; }
}

/** Rama o tag tal como lo manda el webview: nombre completo y repos en los que actuar. */
interface RefPayload { full: string; name: string; type: string; repos: number[] }

/** Error de un repo en una acción repetida en varios repos. */
interface RepoError { repo: Repo; message: string }

// ---------------------------------------------------------------------------
// Vista principal
// ---------------------------------------------------------------------------

export class GitLogViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'jbGit.log';

  private view?: vscode.WebviewView;
  private ready = false;
  // Confirmaciones abiertas en el panel (diálogo del webview): id → resolve
  private confirms = new Map<number, (r: any) => void>();
  private confirmSeq = 0;
  private repos: Repo[] = [];
  private changesTimer?: NodeJS.Timeout;
  private changesRunning?: Promise<void>;
  private changesAgain = false;
  private refreshTimer?: NodeJS.Timeout;
  private readonly refreshGen = new Generation();
  /** Filtro de rama: null (todas), 'HEAD', una rama común ('refs/heads/main') o «idx,idx|ref» */
  private filterRef: string | null = null;
  private logFilters: LogFilters = { ...EMPTY_FILTERS };
  private extraCommits = 0;
  private pendingWhileHidden = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.init();
  }

  dispose() {
    this.repos.forEach(r => r.dispose());
  }

  // ----- ciclo de vida ----------------------------------------------------

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.getHtml(view.webview, media);
    this.updateDescription();
    view.webview.onDidReceiveMessage(m => this.onMessage(m));
    view.onDidChangeVisibility(() => {
      if (view.visible && this.pendingWhileHidden) { this.refresh(); }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
      this.cancelConfirms();
    });
  }

  /** Busca los repositorios del workspace (la carpeta abierta puede contener varios). */
  async init() {
    const maxDepth = scanDepth(vscode.workspace.getConfiguration('jbGit'));
    const roots = await findRepositories((vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath), maxDepth);
    const same = roots.length === this.repos.length && roots.every((r, i) => this.repos[i].root === r);
    if (!same) {
      this.repos.forEach(r => r.dispose());
      this.repos = roots.map((root, i) => new Repo(i, root));
      this.repos.forEach(r => { void this.watch(r); });
      this.filterRef = null;
      this.logFilters = { ...EMPTY_FILTERS };
      this.extraCommits = 0;
    }
    this.updateDescription();
    if (!this.repos.length) { this.post({ type: 'noRepo' }); return; }
    return this.refresh();
  }

  private async watch(repo: Repo) {
    // Los directorios de git no cuelgan siempre de «<raíz>/.git»: en un worktree o un
    // submódulo `.git` es un archivo. Se preguntan a git; si falla, se supone el normal.
    const fallback = path.join(repo.root, '.git');
    const dirs = await repo.git.gitDirs().catch(() => ({ dir: fallback, common: fallback }));
    if (repo.disposed) { return; } // se rehicieron los repos mientras git contestaba
    const specs = watchSpecs(repo.root, dirs).map(sp => ({
      ...sp, w: vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(sp.dir), sp.pattern)),
    }));
    const onRefs = () => this.scheduleRefresh();
    const onIndex = () => this.scheduleChanges();
    // Los archivos de dentro de .git (también un `.git` que sea un archivo) no son cambios del árbol
    const onTree = (u: vscode.Uri) => { if (!/[\\/]\.git([\\/]|$)/.test(u.fsPath)) { this.scheduleChanges(); } };
    repo.watchers = specs.flatMap(({ w, kind }) => {
      const h = kind === 'refs' ? onRefs : kind === 'index' ? onIndex : onTree;
      return [w, w.onDidChange(h), w.onDidCreate(h), w.onDidDelete(h)];
    });
  }

  /** Ruta de un repo relativa a la carpeta abierta que lo contiene (para los menús). */
  private relToWorkspace(p: string): string {
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const rel = path.relative(f.uri.fsPath, p);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) { return rel.split(path.sep).join('/') || '.'; }
    }
    return p;
  }

  /** Título del panel: el repositorio, o cuántos hay. */
  private updateDescription() {
    if (!this.view) { return; }
    this.view.description = this.repos.length === 1 ? this.repos[0].name
      : this.repos.length > 1 ? `${this.repos.length} repositories` : undefined;
  }

  private repo(idx: any): Repo | undefined {
    return this.repos[Number(idx)];
  }

  /** «idx:hash» → repo y hash. */
  private decode(id: any): { repo: Repo; hash: string } | undefined {
    const m = /^(\d+):([0-9a-f]{4,64})$/i.exec(String(id ?? ''));
    const repo = m ? this.repo(m[1]) : undefined;
    return repo && m ? { repo, hash: m[2] } : undefined;
  }

  // ----- refresco ---------------------------------------------------------

  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 400);
  }

  private scheduleChanges() {
    clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => this.refreshChanges(), 300);
  }

  /** Repos que muestra el log según el filtro Paths (sin nada: todos). */
  private includedRepos(): Repo[] {
    const f = this.logFilters;
    if (!f.roots.length && !f.paths.length) { return this.repos; }
    return this.repos.filter(r => f.roots.includes(r.root) || this.pathsFor(r).length > 0);
  }

  /** Rutas del filtro Paths que caen dentro de un repo, relativas a su raíz. */
  private pathsFor(repo: Repo): string[] {
    return this.logFilters.paths
      .map(p => path.relative(repo.root, p))
      .filter(r => r && !r.startsWith('..') && !path.isAbsolute(r))
      .map(r => r.split(path.sep).join('/'));
  }

  /** Ref para git log en un repo según el filtro de rama: undefined = todas, null = el repo no entra. */
  private refFor(repo: Repo): string | null | undefined {
    const f = this.filterRef;
    if (!f) { return undefined; }
    if (f === 'HEAD') { return 'HEAD'; }
    const bar = f.indexOf('|');
    if (bar >= 0) {
      const ids = f.slice(0, bar).split(',').map(Number);
      return ids.includes(repo.idx) ? f.slice(bar + 1) : null;
    }
    return repo.refs.some(r => r.full === f) ? f : null;
  }

  async refresh() {
    if (!this.view || !this.ready) { return; }
    if (!this.view.visible) { this.pendingWhileHidden = true; return; }
    this.pendingWhileHidden = false;
    if (!this.repos.length) { this.post({ type: 'noRepo' }); return; }

    const cfg = vscode.workspace.getConfiguration('jbGit');
    const max = commitsPerPage(cfg) + this.extraCommits;
    // Cada refresh lleva un número: si mientras espera a git empieza otro, el viejo
    // descarta su resultado (si no, podría llegar después y pisar los datos nuevos)
    const gen = this.refreshGen.begin();
    try {
      await Promise.all(this.repos.map(r => r.load()));
      if (this.refreshGen.stale(gen)) { return; }
      const included = this.includedRepos();
      this.loadRemoteTags();
      const tree = this.branchTree(included);
      // Si cambian los repos del log, la clave de la rama filtrada puede cambiar
      // («0,2|refs/heads/x» ↔ «refs/heads/x»); si ya no existe en ningún repo, se quita el filtro.
      if (this.filterRef && this.filterRef !== 'HEAD' && !tree.some(n => n.key === this.filterRef)) {
        const full = this.filterRef.slice(this.filterRef.indexOf('|') + 1);
        this.filterRef = tree.find(n => n.full === full)?.key ?? null;
      }

      const f = this.logFilters;
      const filtered = f.authors.length > 0 || !!f.since || !!f.until || f.paths.length > 0;
      const perRepo = await Promise.all(included.map(async repo => {
        const ref = this.refFor(repo);
        if (ref === null) { return { repo, commits: [] as LogCommit[], limited: false }; }
        const restrict = f.roots.includes(repo.root) ? [] : this.pathsFor(repo);
        const commits = await repo.git.getLog(ref ?? null, max, { ...f, paths: restrict, firstParent: this.firstParent() });
        return { repo, commits, limited: commits.length >= max };
      }));
      if (this.refreshGen.stale(gen)) { return; }
      const { commits, hasMore } = mergeLogs(perRepo, max);
      let list = commits.map(({ repo, c }) => ({
        ...c, sha: c.hash, repo: repo.idx, hash: repo.id(c.hash), parents: c.parents.map(p => repo.id(p)),
      }));
      if (filtered) {
        // Con filtros faltan commits intermedios: los padres que no están en la lista se
        // quitan para que el grafo no arrastre carriles que nunca terminan
        const inList = new Set(list.map(c => c.hash));
        list = list.map(c => ({ ...c, parents: c.parents.filter(p => inList.has(p)) }));
      }
      const graph = computeGraph(list, this.longEdges(), this.branchColorFn(included));
      const favs = this.favoriteSets();
      this.post({
        type: 'data',
        multi: this.repos.length > 1,
        repos: this.repos.map(r => {
          const cur = r.currentRef();
          return {
            idx: r.idx, name: r.name, root: r.root, me: r.me, included: included.includes(r), rel: this.relToWorkspace(r.root),
            head: { hash: r.head.hash ? r.id(r.head.hash) : '', branch: r.head.branch },
            ahead: cur?.ahead ?? 0, behind: cur?.behind ?? 0, upstream: cur?.upstream ?? '',
            op: r.op,
          };
        }),
        // Refs de cada repo, para las etiquetas de los commits y los menús de commit
        refs: included.flatMap(r => r.refs.map(x => ({
          ...x, hash: r.id(x.hash), repo: r.idx, key: `${r.idx}|${x.full}`, repos: [r.idx],
          favorite: x.type !== 'tag' && favs[r.idx].has(x.full),
          current: x.type === 'local' && x.name === r.head.branch,
        }))),
        // Ramas para el árbol, el filtro Branch y la barra: las comunes una vez y el resto con su repo
        tree: tree.map(n => ({
          ...n,
          favorite: n.type !== 'tag' && n.repos.every(i => favs[i].has(n.full)),
          protected: n.type === 'remote' && this.isProtectedRemote(n.full, n.repos),
          // Tags sin subir al remoto en alguno de sus repos (carpeta Tags ▸ Local)
          unpushed: n.type === 'tag' && n.repos.some(i => this.repos[i]?.tagUnpushed(n.name) === true),
        })),
        filterRef: this.filterRef,
        logFilters: this.logFilters,
        firstParent: this.firstParent(),
        longEdges: this.longEdges(),
        hasMore,
        dateFormat: cfg.get<string>('dateFormat', 'absolute'),
        commits: list.map((c, i) => ({ ...c, g: graph[i] })),
      });
      await this.refreshChanges();
      await this.refreshStashes();
    } catch (e: any) {
      if (!this.refreshGen.stale(gen)) { this.post({ type: 'error', message: e.message }); }
    }
  }

  /**
   * Ramas y tags de los repos incluidos. Una rama que está en todos es común y sale una
   * vez (clave: su nombre completo). Si solo está en algunos, su clave lleva los repos
   * («0,2|refs/heads/x») y el webview muestra su nombre al lado.
   */
  private branchTree(included: Repo[]) {
    const byFull = new Map<string, { ref: Ref; repos: Repo[] }>();
    for (const r of included) {
      for (const x of r.refs) {
        const e = byFull.get(x.full);
        if (e) { e.repos.push(r); } else { byFull.set(x.full, { ref: x, repos: [r] }); }
      }
    }
    return [...byFull.values()].map(({ ref, repos }) => {
      const common = repos.length === included.length;
      const ids = repos.map(r => r.idx);
      const mine = repos.map(r => r.refs.find(x => x.full === ref.full)!);
      return {
        key: common ? ref.full : `${ids.join(',')}|${ref.full}`,
        full: ref.full, name: ref.name, type: ref.type, remote: ref.remote, branch: ref.branch,
        repos: ids, common, repoNames: common ? '' : repos.map(r => r.name).join(', '),
        ahead: mine.reduce((s, x) => s + (x.ahead ?? 0), 0),
        behind: mine.reduce((s, x) => s + (x.behind ?? 0), 0),
        // Commits pendientes de cada repo (el tooltip de ↑/↓ los reparte)
        sync: repos.map((r, i) => ({ repo: r.idx, ahead: mine[i].ahead ?? 0, behind: mine[i].behind ?? 0 })).filter(x => x.ahead || x.behind),
        hasUpstream: mine.every(x => !!x.upstream),
        current: ref.type === 'local' && repos.every(r => r.head.branch === ref.name),
      };
    });
  }

  /**
   * Consulta en segundo plano los tags del remoto de los repos que lo necesitan y, si
   * cambian, vuelve a pintar. Si falla (sin red, sin permisos), se reintenta tras el
   * siguiente fetch, pull o push.
   */
  private loadRemoteTags() {
    for (const r of this.repos) {
      if (!r.remoteTagsStale || r.remoteTagsLoading) { continue; }
      r.remoteTagsStale = false;
      const remote = r.defaultRemote();
      if (!remote) { r.remoteTags = null; continue; }
      r.remoteTagsLoading = true;
      r.git.getRemoteTags(remote).then(tags => {
        const before = r.remoteTags;
        r.remoteTags = tags;
        const same = before && before.size === tags.size && [...tags].every(t => before.has(t));
        if (!same) { this.scheduleRefresh(); }
      }, () => { /* sin conexión: se queda como estaba */ }).finally(() => { r.remoteTagsLoading = false; });
    }
  }

  /** Envía a Local Changes los cambios de todos los repos (sin solaparse: el auto-stage escribe en el índice). */
  async refreshChanges(): Promise<void> {
    if (!this.view || !this.ready || !this.repos.length) { return; }
    if (!this.view.visible) { this.pendingWhileHidden = true; return; }
    if (this.changesRunning) { this.changesAgain = true; return this.changesRunning; }
    this.changesRunning = (async () => {
      do {
        this.changesAgain = false;
        await this.doRefreshChanges();
      } while (this.changesAgain);
    })().finally(() => { this.changesRunning = undefined; });
    return this.changesRunning;
  }

  /**
   * Cola de escrituras al índice: el auto-stage y las acciones del usuario (Stage, Unstage,
   * Rollback, bloques, Commit) pasan de una en una. Sin esto, dos `git add`/`reset` a la vez
   * chocan con `index.lock`, y el auto-stage puede pisar la lista de excluidos que el usuario
   * acaba de cambiar. Nada de lo que se ejecuta aquí dentro debe esperar a otro `locked`,
   * ni abrir un cuadro de confirmación (se quedaría el índice bloqueado hasta responder).
   */
  private readonly indexQueue = new SerialQueue();
  private locked<T>(fn: () => Promise<T>): Promise<T> { return this.indexQueue.run(fn); }

  private async doRefreshChanges() {
    const auto = vscode.workspace.getConfiguration('jbGit').get<boolean>('autoStage', true);
    const errors: string[] = [];
    const all = await Promise.all(this.repos.map(async repo => {
      try {
        const files = await this.locked(async () => {
          const st = await repo.git.getStatus();
          return auto ? this.autoStage(repo, st) : st;
        });
        return files.map(f => ({ ...f, repo: repo.idx }));
      } catch (e: any) {
        errors.push(`${repo.name}: ${e.message}`);
        return [];
      }
    }));
    const files = all.flat();
    // Mensaje para Amend: el del repo con cambios en stage (o el primero)
    const primary = this.repo(files.find(f => f.group === 'staged')?.repo) ?? this.repos[0];
    const lastMessage = primary ? await primary.git.getLastMessage() : '';
    this.post({ type: 'changes', files, lastMessage, error: errors.join('\n') || undefined });
  }

  // ----- auto-stage ------------------------------------------------------------------

  /**
   * Como en JetBrains, todos los cambios de archivos con seguimiento van al commit por
   * defecto: se añaden al índice salvo los que el usuario ha sacado con «−» (excluidos).
   * Los archivos sin seguimiento y los conflictos no se tocan nunca.
   */
  private async autoStage(repo: Repo, files: LocalChange[]): Promise<LocalChange[]> {
    const excluded = this.getExcluded(repo);
    // Un excluido que ya no tiene cambios deja de estarlo: la próxima vez que cambie, entra
    const present = new Set(files.flatMap(f => f.oldPath ? [f.path, f.oldPath] : [f.path]));
    const kept = [...excluded].filter(p => present.has(p));
    if (kept.length !== excluded.size) { await this.setExcluded(repo, kept); }
    const keep = new Set(kept);
    const toAdd = [...new Set(files.filter(f => f.group === 'unstaged' && !keep.has(f.path)).map(f => f.path))];
    if (!toAdd.length) { return files; }
    try {
      await repo.git.run(['add', '-A', '--', ...toAdd]);
    } catch (e: any) {
      // Otro git (un pull, un rebase, el propio VS Code) tiene el índice: no es un error
      // que mostrar, se vuelve a intentar enseguida
      if (!/index\.lock/.test(e.message)) { throw e; }
      clearTimeout(this.changesTimer);
      this.changesTimer = setTimeout(() => this.refreshChanges(), 1000);
      return files;
    }
    return repo.git.getStatus();
  }

  private static readonly EXCLUDED_KEY = 'jbGit.excludedFromCommit';
  private static readonly FIRST_PARENT_KEY = 'jbGit.firstParent';
  private firstParent(): boolean { return this.context.workspaceState.get<boolean>(GitLogViewProvider.FIRST_PARENT_KEY, false); }
  private static readonly LONG_EDGES_KEY = 'jbGit.showLongEdges';
  private longEdges(): boolean { return this.context.workspaceState.get<boolean>(GitLogViewProvider.LONG_EDGES_KEY, false); }

  private getExcluded(repo: Repo): Set<string> {
    const all = this.context.workspaceState.get<Record<string, string[]>>(GitLogViewProvider.EXCLUDED_KEY, {});
    return new Set(all[repo.root] ?? []);
  }

  private async setExcluded(repo: Repo, paths: Iterable<string>) {
    const all = { ...this.context.workspaceState.get<Record<string, string[]>>(GitLogViewProvider.EXCLUDED_KEY, {}) };
    all[repo.root] = [...new Set(paths)];
    await this.context.workspaceState.update(GitLogViewProvider.EXCLUDED_KEY, all);
  }

  /** Envía a la pestaña Stash los stashes de todos los repos, del más reciente al más antiguo. */
  async refreshStashes() {
    if (!this.view || !this.ready || !this.repos.length) { return; }
    const errors: string[] = [];
    const lists = await Promise.all(this.repos.map(async repo => {
      try {
        return (await repo.git.getStashes()).map(s => ({ ...s, repo: repo.idx, id: repo.id(s.hash) }));
      } catch (e: any) {
        errors.push(`${repo.name}: ${e.message}`);
        return [];
      }
    }));
    this.post({ type: 'stashes', list: lists.flat().sort((a, b) => b.time - a.time), error: errors.join('\n') || undefined });
  }

  // ----- ramas favoritas ----------------------------------------------------------

  /**
   * Las favoritas se guardan en globalState por ruta del repositorio, para que se
   * conserven aunque el repo se abra desde otro workspace. Mientras el usuario no
   * marque ninguna, main y master son favoritas por defecto, como en JetBrains.
   */
  private static readonly FAVORITES_KEY = 'jbGit.favorites';

  private favoriteSets(): Set<string>[] {
    const all = this.context.globalState.get<Record<string, string[]>>(GitLogViewProvider.FAVORITES_KEY, {});
    return this.repos.map(r => new Set(all[r.root] ?? ['refs/heads/main', 'refs/heads/master']));
  }

  /** Una rama común es favorita si lo es en todos sus repos; al cambiarla se cambia en todos. */
  private async toggleFavorite(items: { full: string; repos: number[] }[]) {
    const list = items
      .filter(x => x && typeof x.full === 'string' && x.full.startsWith('refs/'))
      .map(x => ({ full: x.full, repos: this.reposOf(x.repos) }))
      .filter(x => x.repos.length);
    if (!list.length) { return; }
    const sets = this.favoriteSets();
    // Si ya son todas favoritas se desmarcan; si no, se marcan todas
    const on = !list.every(x => x.repos.every(r => sets[r.idx].has(x.full)));
    const all = { ...this.context.globalState.get<Record<string, string[]>>(GitLogViewProvider.FAVORITES_KEY, {}) };
    for (const { full, repos } of list) {
      for (const r of repos) {
        const s = sets[r.idx];
        if (on) { s.add(full); } else { s.delete(full); }
        all[r.root] = [...s];
      }
    }
    await this.context.globalState.update(GitLogViewProvider.FAVORITES_KEY, all);
    return this.refresh();
  }

  private reposOf(ids: any): Repo[] {
    return (Array.isArray(ids) ? ids : []).map(i => this.repo(i)).filter((r): r is Repo => !!r);
  }

  /**
   * Confirmación en un diálogo dentro del panel Git (media/main.js, showConfirm), del tamaño de
   * su contenido; la ventana flotante de VS Code no deja fijar su tamaño y para un aviso corto
   * salía enorme. Resuelve con { ok, checked }, o undefined si el panel se cierra o se recarga.
   */
  private async confirmInPanel(data: Record<string, unknown>): Promise<{ ok: boolean; checked: boolean } | undefined> {
    return this.dialogInPanel('confirm', data);
  }

  /**
   * Diálogo propio del webview sobre el panel Git (confirm, mergeDialog). Resuelve con lo que
   * responda la página (confirmResult / dialogResult), o undefined si el panel se cierra o se recarga.
   */
  private async dialogInPanel(type: string, data: Record<string, unknown>): Promise<any> {
    if (!this.view || !this.ready) {
      await vscode.commands.executeCommand('jbGit.log.focus');
      for (let i = 0; i < 50 && !(this.view && this.ready); i++) { await new Promise(r => setTimeout(r, 100)); }
      if (!this.view || !this.ready) { return undefined; }
    }
    this.view.show?.(true);
    const id = ++this.confirmSeq;
    return new Promise(resolve => {
      this.confirms.set(id, resolve);
      this.post({ ...data, type, id });
    });
  }

  private cancelConfirms() {
    for (const r of this.confirms.values()) { r(undefined); }
    this.confirms.clear();
  }

  private post(msg: unknown) {
    if (this.view && this.ready) { this.view.webview.postMessage(msg); }
  }

  // ----- mensajes desde el webview ------------------------------------------

  private async onMessage(m: any) {
    switch (m.type) {
      case 'pickMerge':
        return this.guard(() => this.pickMerge(String(m.preselect ?? '')));
      case 'confirmResult':
        this.confirms.get(Number(m.id))?.({ ok: !!m.ok, checked: !!m.checked });
        this.confirms.delete(Number(m.id));
        return;
      case 'dialogResult':
        this.confirms.get(Number(m.id))?.(m);
        this.confirms.delete(Number(m.id));
        return;
      case 'ready':
        this.cancelConfirms();
        this.ready = true;
        this.postSettings();
        if (this.repos.length) { this.refresh(); } else { this.init(); }
        return;
      case 'refresh':
        return this.init();
      case 'setSetting':
        return this.guard(() => this.setSetting(String(m.key ?? ''), m.value));
      case 'openSettings':
        return vscode.commands.executeCommand('workbench.action.openSettings', 'jbGit');
      case 'filter':
        this.filterRef = typeof m.ref === 'string' ? m.ref : null;
        this.extraCommits = 0;
        // Rama de solo algunos repos: el filtro Paths se queda con esos repos
        if (Array.isArray(m.roots)) {
          const known = new Set(this.repos.map(r => r.root));
          this.logFilters = { ...this.logFilters, roots: m.roots.filter((r: any) => known.has(r)) };
        }
        return this.refresh();
      case 'logOption':
        // Opciones del ojo del Log que cambian el git log o el grafo
        if (m.key === 'firstParent') {
          this.extraCommits = 0;
          return this.context.workspaceState.update(GitLogViewProvider.FIRST_PARENT_KEY, !!m.value).then(() => this.refresh());
        }
        if (m.key === 'longEdges') {
          return this.context.workspaceState.update(GitLogViewProvider.LONG_EDGES_KEY, !!m.value).then(() => this.refresh());
        }
        return;
      case 'logFilter':
        return this.guard(() => this.setLogFilter(m.key, m.value));
      case 'pickLogFilter':
        return this.guard(() => this.pickLogFilter(m.key));
      case 'loadMore':
        this.extraCommits += commitsPerPage(vscode.workspace.getConfiguration('jbGit'));
        return this.refresh();
      case 'selectCommit':
        return this.sendDetails(m.hash);
      case 'openFileDiff':
        return this.openCommitFileDiff(m.hash, m.parent ?? null, m.file as FileChange);
      case 'openFile': {
        const d = this.decode(m.hash);
        if (d) { return this.openWorkingFile(d.repo, m.path); }
        return;
      }
      case 'commitAction':
        return this.guard(() => this.commitAction(m.action, m.hash));
      case 'showHistory': {
        const repo = this.repo(m.repo);
        if (repo && typeof m.path === 'string') {
          const d = m.hash ? this.decode(m.hash) : undefined;
          this.showHistory(repo, m.path, !!m.folder, d?.hash);
        }
        return;
      }
      case 'commitsAction':
        return this.guard(() => this.commitsAction(m.action, m.hashes));
      case 'branchAction': {
        const ref = this.refPayload(m.ref);
        return ref ? this.guard(() => this.branchAction(m.action, ref)) : undefined;
      }
      case 'tagAction':
        return this.guard(() => this.tagAction(m.action, String(m.name ?? ''), this.reposOf(m.repos)));
      case 'ignore':
        return this.guard(() => this.addIgnore(m.target === 'exclude' ? 'exclude' : 'gitignore', (m.items ?? []) as { repo: number; pattern: string }[]));
      case 'stageBlock':
        return this.guard(() => this.locked(() => this.stageBlock(m.change as Change, Number(m.block), (m.lines ?? []) as string[])));
      case 'rollbackBlock':
        return this.guard(() => this.locked(() => this.rollbackBlock(m.change as Change, Number(m.block), (m.lines ?? []) as string[])));
      case 'previewChange':
        return this.sendChangePreview(m.change as Change);
      case 'openChange':
        return this.guard(() => this.openChange(m.change as Change));
      case 'changeAction':
        return this.guard(() => this.changeAction(m.action, (m.changes ?? []) as Change[]));
      case 'opAction':
        return this.guard(() => this.opAction(this.repo(m.repo), String(m.action ?? '')));
      case 'commit':
        return this.guard(() => this.commit(String(m.message ?? ''), !!m.amend, !!m.push));
      case 'selectStash':
        return this.sendStashFiles(m.id);
      case 'openStashDiff':
        return this.guard(() => this.openStashDiff(m.id, m.file as StashFile));
      case 'stashAction':
        return this.guard(() => this.stashAction(m.action, m.id, String(m.ref ?? '')));
      case 'toggleFavorite':
        // Una rama ({ ref, repos }) o varias ({ refs: [{ full, repos }] }), que se marcan o desmarcan juntas
        return this.toggleFavorite(Array.isArray(m.refs) ? m.refs : [{ full: m.ref, repos: m.repos }]);
      case 'branchesAction':
        return this.guard(() => this.branchesAction(m.action,
          (Array.isArray(m.refs) ? m.refs : []).map((x: unknown) => this.refPayload(x)).filter((x: RefPayload | undefined): x is RefPayload => !!x)));
      case 'repoAction':
        return this.guard(() => this.repoAction(m.action, (m.changes ?? []) as Change[]));
    }
  }

  /**
   * Rama o tag que manda el webview, rehecho con lo que hay de verdad en los repos: solo se
   * usa su nombre completo (full) y sus repos; el nombre corto y el tipo salen de la ref real
   * (así ni un nombre que empiece por «-» llega a git como opción, ni se salta la protección de
   * ramas haciéndose pasar por otra). undefined si no existe en ninguno de esos repos.
   */
  private refPayload(raw: any): RefPayload | undefined {
    if (!raw || typeof raw.full !== 'string') { return undefined; }
    const repos = this.reposOf(raw.repos).filter(r => r.refs.some(x => x.full === raw.full));
    const ref = repos[0]?.refs.find(x => x.full === raw.full);
    if (!ref || ref.name.startsWith('-')) { return undefined; }
    return { full: ref.full, name: ref.name, type: ref.type, repos: repos.map(r => r.idx) };
  }

  private async guard(fn: () => Promise<unknown>) {
    if (!this.repos.length) { return; }
    try {
      await fn();
    } catch (e: any) {
      vscode.window.showErrorMessage(e.message);
    }
  }

  private async sendDetails(id: string) {
    const d = this.decode(id);
    if (!d) { return; }
    try {
      const details = await d.repo.git.getCommitDetails(d.hash);
      this.post({
        type: 'details',
        details: { ...details, sha: details.hash, hash: id, parents: details.parents.map(p => d.repo.id(p)), repo: d.repo.idx, repoName: d.repo.name },
      });
    } catch (e: any) {
      this.post({ type: 'details', details: null, hash: id, error: e.message });
    }
  }

  // ----- diffs ----------------------------------------------------------------

  /** viewColumn: desde la ventana flotante de Push, el diff se abre en la ventana principal (ViewColumn.One). */
  private async openCommitFileDiff(id: string, parentId: string | null, f: FileChange, viewColumn?: vscode.ViewColumn) {
    const d = this.decode(id);
    if (!d) { return; }
    const parent = parentId ? this.decode(parentId)?.hash ?? null : null;
    const root = d.repo.root, hash = d.hash;
    const left = f.status === 'A' || !parent ? revisionUri(root, '', f.path) : revisionUri(root, parent, f.oldPath ?? f.path);
    const right = f.status === 'D' ? revisionUri(root, '', f.path) : revisionUri(root, hash, f.path);
    const title = `${path.basename(f.path)} (${parent ? parent.slice(0, 8) : 'empty'} ↔ ${hash.slice(0, 8)})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, preserveFocus: true, ...(viewColumn ? { viewColumn } : {}) });
  }

  private openWorkingFile(repo: Repo, rel: string) {
    return showWorkingFile(repo.root, rel);
  }

  /**
   * Compara dos revisiones (right undefined = árbol de trabajo) en una pestaña del editor,
   * como JetBrains: lista de archivos a la izquierda y diff lado a lado a la derecha
   * (ComparePanel). El doble clic en un archivo abre también el diff nativo de VS Code.
   */
  private async pickAndDiff(repo: Repo, left: string, right: string | undefined, title: string) {
    const git = repo.git;
    if (this.repos.length > 1) { title = `${repo.name}: ${title}`; }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    ComparePanel.open(media, git, left, right, title, this.nativeDiff(git, title));
  }

  /** Diff nativo de VS Code de un archivo entre dos revisiones (right undefined = árbol de trabajo). */
  private nativeDiff(git: Git, title: string) {
    return (f: FileChange, left: string, right: string | undefined) => {
      const l = f.status === 'A' ? revisionUri(git.root, '', f.path) : revisionUri(git.root, left, f.oldPath ?? f.path);
      let r: vscode.Uri;
      if (f.status === 'D') { r = revisionUri(git.root, '', f.path); }
      else if (right) { r = revisionUri(git.root, right, f.path); }
      else { r = vscode.Uri.file(path.join(git.root, f.path)); }
      const t = right ? `${path.basename(f.path)} (${left.slice(0, 8)} ↔ ${right.slice(0, 8)})` : `${path.basename(f.path)} (${title})`;
      return vscode.commands.executeCommand('vscode.diff', l, r, t, { preview: true });
    };
  }

  /**
   * Show History de un archivo o carpeta (rel: ruta relativa al repo; '' = el repo entero),
   * como JetBrains: una pestaña en el editor con los commits que lo tocaron y el diff de
   * cada uno. rev: empezar desde ese commit (p. ej. desde los detalles de un commit, por si
   * el archivo ya no existe en HEAD).
   */
  showHistory(repo: Repo, rel: string, folder: boolean, rev?: string) {
    const name = rel ? path.basename(rel) : repo.name;
    const title = `History: ${name}${this.repos.length > 1 && rel ? ` (${repo.name})` : ''}`;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    ComparePanel.openHistory(media, repo.git, { path: rel || '.', folder, rev }, title, this.nativeDiff(repo.git, title));
  }

  /** Show History desde el explorador o el editor: busca el repo más profundo que contiene la ruta. */
  async showHistoryForUri(uri?: vscode.Uri) {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') { vscode.window.showWarningMessage('Select a file or folder to show its history.'); return; }
    if (!this.repos.length) { await this.init(); }
    const p = target.fsPath;
    // pathInside: fsPath es «c:\…» y la raíz, «C:\…» (y en macOS no se distinguen mayúsculas)
    const repo = [...this.repos].filter(r => pathInside(r.root, p)).sort((a, b) => b.root.length - a.root.length)[0];
    if (!repo) { vscode.window.showWarningMessage(`'${path.basename(p)}' is not in a Git repository of this workspace.`); return; }
    let folder = false;
    try { folder = (await fs.stat(p)).isDirectory(); } catch { /* borrado: se trata como archivo */ }
    this.showHistory(repo, path.relative(repo.root, p).split(path.sep).join('/'), folder);
  }

  // ----- helpers -------------------------------------------------------------

  private async exec(repo: Repo, args: string[], title?: string) {
    const prefix = this.repos.length > 1 ? `${repo.name}: ` : '';
    // Tras hablar con el remoto, los tags que tiene pueden haber cambiado
    if (['fetch', 'pull', 'push'].includes(args[0])) { repo.remoteTagsStale = true; }
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: prefix + (title ?? `git ${args.join(' ')}`) },
        () => repo.git.run(args)
      );
    } finally {
      this.scheduleRefresh();
    }
  }

  /**
   * Repite una acción en varios repos. Si alguno falla sigue con los demás y al final
   * muestra los errores juntos, cada uno con el nombre de su repo.
   */
  private async forEachRepo(repos: Repo[], fn: (r: Repo) => Promise<unknown>) {
    const errors: RepoError[] = [];
    for (const r of repos) {
      try { await fn(r); } catch (e: any) { errors.push({ repo: r, message: e.message }); }
    }
    if (!errors.length) { return; }
    if (repos.length === 1) { throw new Error(errors[0].message); }
    throw new Error(errors.map(e => `${e.repo.name}: ${e.message}`).join('\n'));
  }

  /**
   * Botón Merge: la ventana Merge de JetBrains como cuadro sobre el panel Git (showMergeDialog
   * en main.js): las ramas locales y remotas de los repos del log menos la actual, favoritas
   * primero, con buscador, la seleccionada en el árbol (preselect) marcada, y las opciones de
   * git merge (Modify options). La elegida se mergea en la rama actual de cada repo que la
   * tiene (branchAction merge). Si el panel no está disponible, el selector nativo.
   */
  private async pickMerge(preselect: string) {
    const included = this.includedRepos();
    const favs = this.favoriteSets();
    const nodes = this.branchTree(included)
      .filter(n => n.type !== 'tag' && !n.current && n.repos.some(i => this.repos[i]?.head.branch));
    if (!nodes.length) { vscode.window.showInformationMessage('There are no other branches to merge.'); return; }
    const fav = (n: typeof nodes[number]) => n.repos.every(i => favs[i].has(n.full));
    const sort = (a: typeof nodes[number], b: typeof nodes[number]) => Number(fav(b)) - Number(fav(a)) || a.name.localeCompare(b.name);
    const list = ['local', 'remote'].flatMap(t => nodes.filter(n => n.type === t).sort(sort));
    const curs = [...new Set(included.map(r => r.head.branch).filter(Boolean))];
    const res = await this.dialogInPanel('mergeDialog', {
      heading: `Merge into ${curs.length === 1 ? `'${curs[0]}'` : 'the current branch'}`,
      repos: this.repos.length > 1 ? included.map(r => r.name) : [],
      branches: list.map(n => ({ key: n.key, name: n.name, type: n.type, fav: fav(n), repoNames: n.repoNames })),
      preselect,
    });
    // undefined: el panel no se pudo abrir (entonces, el selector nativo) o se recargó o cerró
    // con la ventana abierta (entonces no se hace nada, como al cancelar)
    if (res === undefined) { return this.view ? undefined : this.pickMergeNative(preselect); }
    if (!res.ok) { return; }
    const n = nodes.find(x => x.key === res.key);
    if (!n) { return; }
    // Solo opciones conocidas; el mensaje, con -m
    return this.branchAction('merge', { full: n.full, name: n.name, type: n.type, repos: n.repos }, mergeArgs(res.options, res.message));
  }

  /** Selector nativo de rama para Merge (por si el panel no está disponible). */
  private async pickMergeNative(preselect: string) {
    const included = this.includedRepos();
    const favs = this.favoriteSets();
    const nodes = this.branchTree(included)
      .filter(n => n.type !== 'tag' && !n.current && n.repos.some(i => this.repos[i]?.head.branch));
    if (!nodes.length) { vscode.window.showInformationMessage('There are no other branches to merge.'); return; }
    const fav = (n: typeof nodes[number]) => n.repos.every(i => favs[i].has(n.full));
    const sort = (a: typeof nodes[number], b: typeof nodes[number]) => Number(fav(b)) - Number(fav(a)) || a.name.localeCompare(b.name);
    type Item = vscode.QuickPickItem & { node?: typeof nodes[number] };
    const items: Item[] = [];
    for (const [label, type, icon] of [['Local', 'local', 'git-branch'], ['Remote', 'remote', 'cloud']] as const) {
      const list = nodes.filter(n => n.type === type).sort(sort);
      if (!list.length) { continue; }
      items.push({ label, kind: vscode.QuickPickItemKind.Separator });
      for (const n of list) {
        items.push({ label: `$(${fav(n) ? 'star-full' : icon}) ${n.name}`, description: n.common ? '' : n.repoNames, node: n });
      }
    }
    const curs = [...new Set(included.map(r => r.head.branch).filter(Boolean))];
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Merge into ${curs.length === 1 ? `'${curs[0]}'` : 'the current branch'}${this.inRepos(included)}`;
    qp.placeholder = 'Search branches';
    qp.matchOnDescription = true;
    qp.items = items;
    const pre = items.find(i => i.node?.key === preselect);
    if (pre) { qp.activeItems = [pre]; }
    const picked = await new Promise<Item | undefined>(resolve => {
      qp.onDidAccept(() => { resolve(qp.selectedItems[0] ?? qp.activeItems[0]); qp.hide(); });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    const n = picked?.node;
    if (n) { return this.branchAction('merge', { full: n.full, name: n.name, type: n.type, repos: n.repos }); }
  }

  /** Mensaje de varias líneas (p. ej. el de un squash) en una ventana flotante. undefined = cancelado. */
  private async askText(title: string, detail: string, text: string, action: string): Promise<string | undefined> {
    const r = await DialogWindow.open(this.media(), { title, kind: 'text', data: { heading: title, detail, text, action, label: 'Commit message' } });
    return r?.ok ? String(r.text ?? '') : undefined;
  }

  private media() { return vscode.Uri.joinPath(this.context.extensionUri, 'media'); }

  /**
   * Confirmación de una acción: el mismo cuadro sobre el panel Git que al borrar ramas
   * (confirmInPanel). Si el panel no está disponible, el modal nativo de VS Code.
   */
  private async confirm(message: string, detail?: string, action = 'Continue', sections: { label: string; items: string[]; icon?: string }[] = []): Promise<boolean> {
    const res = await this.confirmInPanel({ heading: message, notes: detail ? detail.split('\n') : [], sections, action });
    if (res) { return res.ok; }
    if (this.view && this.ready) { return false; }
    const r = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
    return r === action;
  }

  private async askName(prompt: string, value = ''): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({
      prompt,
      value,
      validateInput: v => {
        if (!v.trim()) { return 'Name is required'; }
        // (empezar por «-» tampoco vale: git lo tomaría por una opción)
        if (/[\s~^:?*\[\\]|\.\.|@\{|\/$|\.lock$|^-/.test(v)) { return 'Invalid Git ref name'; }
        return undefined;
      },
    });
    return name?.trim();
  }

  /** « in proj-a, proj-b» para los mensajes cuando hay varios repos. */
  private inRepos(repos: Repo[]): string {
    return this.repos.length > 1 && repos.length ? ` in ${repos.map(r => r.name).join(', ')}` : '';
  }

  /** Para acciones que solo tienen sentido en un repo (diffs): si hay varios, se elige. */
  private async pickRepo(repos: Repo[], title: string): Promise<Repo | undefined> {
    if (repos.length <= 1) { return repos[0]; }
    const pick = await vscode.window.showQuickPick(repos.map(r => ({ label: r.name, description: r.root, r })), { title });
    return pick?.r;
  }

  // ----- acciones sobre commits ------------------------------------------------

  private async commitAction(action: string, id: string) {
    const d = this.decode(id);
    if (!d) { return; }
    const { repo, hash } = d;
    const git = repo.git;
    const short = hash.slice(0, 8);
    const current = repo.head.branch;

    switch (action) {
      case 'copyHash':
        await vscode.env.clipboard.writeText(hash);
        vscode.window.setStatusBarMessage(`$(copy) Copied ${short}`, 2500);
        return;

      case 'createPatch': {
        const patch = await git.run(['format-patch', '-1', '--stdout', hash]);
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(git.root, `${short}.patch`)),
          filters: { Patch: ['patch', 'diff'] },
        });
        if (target) {
          await vscode.workspace.fs.writeFile(target, Buffer.from(patch, 'utf8'));
          vscode.window.showInformationMessage(`Patch saved to ${target.fsPath}`);
        }
        return;
      }

      case 'cherryPick':
        return this.exec(repo, ['cherry-pick', hash], `Cherry-picking ${short}…`);

      case 'checkout':
        if (await this.confirm(`Checkout revision ${short}${this.inRepos([repo])}?`, 'HEAD will be detached from any branch.', 'Checkout')) {
          return this.exec(repo, ['checkout', hash]);
        }
        return;

      case 'compareWithLocal':
        return this.pickAndDiff(repo, hash, undefined, `${short} ↔ Local`);

      case 'reset': {
        const modes = [
          { label: 'Soft', description: 'Keep changes staged', flag: '--soft' },
          { label: 'Mixed', description: 'Keep changes unstaged', flag: '--mixed' },
          { label: 'Hard', description: 'Discard all local changes', flag: '--hard' },
          { label: 'Keep', description: 'Keep local changes not touched by the reset', flag: '--keep' },
        ];
        const mode = await vscode.window.showQuickPick(modes, { title: `Reset '${current || 'HEAD'}'${this.inRepos([repo])} to ${short}` });
        if (!mode) { return; }
        if (mode.flag === '--hard' && !(await this.confirm(`Hard reset to ${short}${this.inRepos([repo])}?`, 'All uncommitted changes will be lost.', 'Reset'))) {
          return;
        }
        return this.exec(repo, ['reset', mode.flag, hash]);
      }

      case 'revert':
        return this.exec(repo, ['revert', '--no-edit', hash], `Reverting ${short}…`);

      case 'undoCommit':
        if (await this.confirm(`Undo commit ${short}${this.inRepos([repo])}?`, 'The commit is removed and its changes stay staged.', 'Undo')) {
          return this.exec(repo, ['reset', '--soft', 'HEAD~1']);
        }
        return;

      case 'newBranch': {
        const name = await this.askName(`New branch from ${short} (it will be checked out)`);
        if (name) { return this.exec(repo, ['checkout', '-b', name, hash]); }
        return;
      }

      case 'newTag': {
        const name = await this.askName(`New tag on ${short}`);
        if (name) { return this.exec(repo, ['tag', name, hash]); }
        return;
      }
    }
  }

  // ----- acciones sobre varios commits seleccionados ------------------------------

  /**
   * Acciones sobre varios commits del log (Ctrl/Shift+clic), como en JetBrains. ids llega
   * en el orden del log (el más nuevo primero). Cherry-pick admite commits de varios repos
   * (cada repo, los suyos); Compare Versions, Squash, Fixup y Drop, de uno solo.
   */
  private async commitsAction(action: string, ids: unknown) {
    const list = (Array.isArray(ids) ? ids : []).map(i => this.decode(i)).filter((d): d is { repo: Repo; hash: string } => !!d);
    if (!list.length) { return; }
    const repos = [...new Set(list.map(d => d.repo))];
    const hashesOf = (r: Repo) => list.filter(d => d.repo === r).map(d => d.hash);

    switch (action) {
      case 'copyHashes':
        await vscode.env.clipboard.writeText(list.map(d => d.hash).join('\n'));
        vscode.window.setStatusBarMessage(`$(copy) Copied ${list.length} revision numbers`, 2500);
        return;

      case 'cherryPick':
        // Del más antiguo al más nuevo, como JetBrains
        return this.forEachRepo(repos, async r => {
          const hs = hashesOf(r).reverse();
          try {
            await this.exec(r, ['cherry-pick', ...hs], `Cherry-picking ${hs.length} commit${hs.length === 1 ? '' : 's'}…`);
          } catch (e: any) {
            if (/CONFLICT|could not apply|after resolving the conflicts/i.test(e.message)) {
              vscode.window.showWarningMessage(`The cherry-pick stopped with conflicts${this.inRepos([r])}. Resolve them in Local Changes and click Continue.`);
              return;
            }
            throw e;
          }
        });

      case 'compare': {
        if (list.length !== 2 || repos.length !== 1) { throw new Error('Select two commits of the same repository to compare them.'); }
        const [newer, older] = list.map(d => d.hash);
        return this.pickAndDiff(repos[0], older, newer, `${older.slice(0, 8)} ↔ ${newer.slice(0, 8)}`);
      }

      case 'squash':
      case 'fixup':
      case 'drop':
        if (repos.length !== 1) { throw new Error('Select commits of a single repository.'); }
        return this.rewriteCommits(repos[0], hashesOf(repos[0]), action);
    }
  }

  /**
   * Squash / Fixup / Drop con un rebase interactivo cuya lista de tareas escribimos
   * nosotros (sequence.editor = cp de nuestro archivo): los commits tienen que estar en la
   * rama actual, sin merges desde el más antiguo hasta HEAD. Squash y Fixup juntan los
   * seleccionados en la posición del más antiguo (fixup de cada uno); Squash además pone el
   * mensaje que se escribe en el diálogo (exec git commit --amend -F). --autostash guarda y
   * recupera los cambios sin commitear. Si se para con conflictos, sigue en la barra de
   * operación (Continue / Abort).
   */
  private async rewriteCommits(repo: Repo, hashes: string[], kind: 'squash' | 'fixup' | 'drop') {
    const git = repo.git;
    const where = this.inRepos([repo]);
    const n = hashes.length;
    if ((kind === 'squash' || kind === 'fixup') && n < 2) { throw new Error('Select at least two commits to squash.'); }
    if (repo.op ?? await git.getOperation()) { throw new Error(`Another operation is in progress${where}: finish or abort it first.`); }
    if (!repo.head.branch) { throw new Error(`HEAD is detached${where}: check out a branch first.`); }
    const branch = repo.head.branch;
    for (const h of hashes) {
      try { await git.run(['merge-base', '--is-ancestor', h, 'HEAD']); } catch {
        throw new Error(`Commit ${h.slice(0, 8)} is not in the current branch '${branch}'${where}.`);
      }
    }
    // El más antiguo: el ancestro común de todos (en una historia lineal, uno de ellos)
    const oldest = (await git.run(['merge-base', '--octopus', ...hashes])).trim();
    if (!hashes.includes(oldest)) { throw new Error('The selected commits are not in a linear history.'); }
    const parent = (await git.run(['rev-list', '--parents', '-n', '1', oldest])).trim().split(' ')[1];
    const range = (await git.run(['rev-list', '--reverse', '--topo-order', '--parents', parent ? `${parent}..HEAD` : 'HEAD']))
      .split('\n').filter(Boolean).map(l => l.split(' '));
    if (range.some(l => l.length > 2)) { throw new Error(`There are merge commits between the selected commits and HEAD${where}: they cannot be rewritten.`); }
    const shas = range.map(l => l[0]);
    const sel = new Set(hashes);

    // Commits ya subidos: en una rama protegida no se tocan; en otra, se avisa del force push
    const remotes = (await git.run(['branch', '-r', '--contains', oldest, '--format=%(refname:short)'])).split('\n').map(x => x.trim()).filter(x => x && !x.endsWith('/HEAD'));
    const prot = this.protectedNames();
    const locked = remotes.filter(x => prot.includes(splitRemoteRef(x, repo.remotes).branch));
    if (locked.length) { throw new Error(`The commits are already in the protected branch '${locked[0]}'${where}: they cannot be rewritten.`); }
    const what = kind === 'drop' ? `Drop ${n} commit${n === 1 ? '' : 's'}` : `${kind === 'squash' ? 'Squash' : 'Fixup'} ${n} commits`;
    const pushedNote = remotes.length ? `\n\nThey are already pushed to ${remotes.slice(0, 3).join(', ')}${remotes.length > 3 ? '…' : ''}: you will need Force Push afterwards.` : '';

    let message: string | undefined;
    if (kind === 'drop') {
      if (!(await this.confirm(`${what} from '${branch}'${where}?`, `The changes of the dropped commits are removed from the history of the branch.${pushedNote}`, 'Drop'))) { return; }
    } else if (kind === 'squash') {
      const msgs: string[] = [];
      for (const h of shas.filter(h => sel.has(h))) { msgs.push((await git.run(['show', '-s', '--format=%B', h])).trim()); }
      message = await this.askText(`Squash ${n} commits in '${branch}'${where}`, `Commit message of the squashed commit.${pushedNote}`, msgs.join('\n\n'), 'Squash');
      if (message === undefined) { return; }
      if (!message.trim()) { throw new Error('The commit message is empty.'); }
    } else if (remotes.length && !(await this.confirm(`${what} in '${branch}'${where}?`, pushedNote.trim(), 'Fixup'))) {
      return;
    }

    // Archivos en el directorio de git (siguen ahí si el rebase se para y se continúa luego)
    const gitPath = async (name: string) => path.resolve(git.root, (await git.run(['rev-parse', '--git-path', name])).trim());
    const q = (p: string) => `'${p.replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;
    const todo: string[] = [];
    if (kind === 'drop') {
      for (const h of shas) { todo.push(`${sel.has(h) ? 'drop' : 'pick'} ${h}`); }
    } else {
      const msgFile = await gitPath('JBGIT_SQUASH_MSG');
      if (message !== undefined) { await fs.writeFile(msgFile, message.replace(/\r\n/g, '\n') + '\n'); }
      for (const h of shas) {
        if (h === oldest) {
          todo.push(`pick ${h}`);
          for (const o of shas) { if (o !== oldest && sel.has(o)) { todo.push(`fixup ${o}`); } }
          if (message !== undefined) { todo.push(`exec git commit --amend --no-verify --allow-empty -F ${q(msgFile)}`); }
        } else if (!sel.has(h)) {
          todo.push(`pick ${h}`);
        }
      }
    }
    const todoFile = await gitPath('JBGIT_REBASE_TODO');
    await fs.writeFile(todoFile, todo.join('\n') + '\n');
    try {
      await this.exec(repo, ['-c', `sequence.editor=cp ${q(todoFile)}`, '-c', 'core.editor=true', 'rebase', '-i', '--autostash', parent ?? '--root'],
        `${what} in '${branch}'…`);
    } catch (e: any) {
      if (/CONFLICT|could not apply|after resolving the conflicts/i.test(e.message)) {
        vscode.window.showWarningMessage(`The rebase stopped with conflicts${where}. Resolve them in Local Changes and click Continue, or Abort to leave '${branch}' as it was.`);
        return;
      }
      throw e;
    } finally {
      this.scheduleChanges();
    }
  }

  // ----- acciones sobre ramas -----------------------------------------------------

  /**
   * Las acciones sobre una rama común se aplican en todos los repos que la tienen, como
   * en JetBrains. Cada repo usa su propia rama actual, upstream y remotos.
   */
  private async branchAction(action: string, payload: RefPayload, mergeArgs: string[] = []) {
    if (!payload || typeof payload.full !== 'string') { return; }
    const repos = this.reposOf(payload.repos).filter(r => r.refs.some(x => x.full === payload.full));
    if (!repos.length) { return; }
    const name = payload.name;
    const where = this.inRepos(repos);
    const refIn = (r: Repo) => r.refs.find(x => x.full === payload.full)!;

    switch (action) {
      case 'checkout':
        return this.forEachRepo(repos, r => {
          const ref = refIn(r);
          if (ref.type === 'local') { return this.exec(r, ['checkout', name]); }
          const local = ref.branch ?? splitRemoteRef(name, r.remotes).branch;
          return r.refs.some(x => x.type === 'local' && x.name === local)
            ? this.exec(r, ['checkout', local])
            : this.exec(r, ['checkout', '-b', local, '--track', name]);
        });

      case 'newBranchFrom': {
        const n = await this.askName(`New branch from '${name}'${where} (it will be checked out)`);
        if (n) { return this.forEachRepo(repos, r => this.exec(r, ['checkout', '-b', n, name])); }
        return;
      }

      case 'checkoutAndRebase':
        return this.forEachRepo(repos, async r => {
          const current = r.head.branch;
          try {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: `${this.repos.length > 1 ? r.name + ': ' : ''}Checkout '${name}' and rebase onto '${current}'…` },
              async () => {
                await r.git.run(['checkout', name]);
                await r.git.run(['rebase', current]);
              }
            );
          } finally {
            this.scheduleRefresh();
          }
        });

      case 'compare': {
        const r = await this.pickRepo(repos, `Compare '${name}' with the current branch in…`);
        if (r) { return this.pickAndDiff(r, r.head.branch, name, `${r.head.branch} ↔ ${name}`); }
        return;
      }

      case 'diffWorkingTree': {
        const r = await this.pickRepo(repos, `Show diff of '${name}' with the working tree in…`);
        if (r) { return this.pickAndDiff(r, name, undefined, `${name} ↔ Working Tree`); }
        return;
      }

      case 'rebaseOnto':
        return this.forEachRepo(repos, r => this.exec(r, ['rebase', name], `Rebasing '${r.head.branch}' onto '${name}'…`));

      case 'merge':
        return this.forEachRepo(repos, r => this.exec(r, ['merge', ...mergeArgs, name], `Merging '${name}' into '${r.head.branch}'…`));

      case 'update':
        return this.forEachRepo(repos, r => {
          const ref = refIn(r);
          if (!ref.upstream) { return Promise.resolve(); }
          const up = splitRemoteRef(ref.upstream, r.remotes);
          return name === r.head.branch
            ? this.exec(r, ['pull', '--ff-only'], `Updating '${name}'…`)
            : this.exec(r, ['fetch', up.remote, `${up.branch}:${name}`], `Updating '${name}'…`);
        });

      case 'push':
        return this.push(repos.map(r => ({ repo: r, ref: refIn(r) })));

      case 'rename': {
        const n = await this.askName(`Rename branch '${name}'${where}`, name);
        if (n && n !== name) { return this.forEachRepo(repos, r => this.exec(r, ['branch', '-m', name, n])); }
        return;
      }

      case 'delete':
        return this.deleteBranches([payload]);
    }
  }

  /** Compara dos ramas cualesquiera (dos seleccionadas en el árbol) en un repo que tenga las dos. */
  private async compareBranches(a: RefPayload, b: RefPayload) {
    const has = (r: Repo, p: RefPayload) => p.repos.includes(r.idx) && r.refs.some(x => x.full === p.full);
    const repos = this.repos.filter(r => has(r, a) && has(r, b));
    if (!repos.length) { vscode.window.showWarningMessage(`'${a.name}' and '${b.name}' are not in the same repository.`); return; }
    const r = await this.pickRepo(repos, `Compare '${a.name}' with '${b.name}' in…`);
    if (r) { return this.pickAndDiff(r, a.name, b.name, `${a.name} ↔ ${b.name}`); }
  }

  /** Update, Push o Delete sobre varias ramas seleccionadas en el árbol (sigue aunque falle una). */
  private async branchesAction(action: string, payloads: RefPayload[]) {
    const refs = payloads.filter(p => p && typeof p.full === 'string' && typeof p.name === 'string');
    if (!refs.length) { return; }
    if (refs.length === 1) { return this.branchAction(action, refs[0]); }
    if (action === 'delete') { return this.deleteBranches(refs); }
    if (action === 'compare') { return this.compareBranches(refs[0], refs[1]); }
    if (action === 'push') {
      // Todas las ramas en una sola ventana de Push
      return this.push(refs.flatMap(p => this.reposOf(p.repos).map(r => ({ repo: r, ref: r.refs.find(x => x.full === p.full)! })).filter(t => t.ref)));
    }
    if (action !== 'update') { return; }
    const errors: string[] = [];
    for (const p of refs) {
      try { await this.branchAction(action, p); } catch (e: any) { errors.push(`${p.name}: ${e.message}`); }
    }
    if (errors.length) { throw new Error(errors.join('\n')); }
  }

  /**
   * Borra una o varias ramas con una sola confirmación. Si alguna es remota y la sigue una
   * rama local, el cuadro sobre el panel (confirmInPanel) ofrece también borrar esa local con
   * la casilla «Delete tracked local branch», como JetBrains.
   */
  private async deleteBranches(refs: RefPayload[]) {
    const existing = refs.filter(p => this.reposOf(p.repos).some(r => r.refs.some(x => x.full === p.full)));
    // Las ramas principales remotas (jbGit.protectedBranches) no se borran nunca
    const locked = existing.filter(p => p.type === 'remote' && this.isProtectedRemote(p.full, p.repos));
    const valid = existing.filter(p => !locked.includes(p));
    if (locked.length) {
      const names = locked.map(p => `'${p.name}'`).join(', ');
      const msg = `${names} ${locked.length === 1 ? 'is a protected branch' : 'are protected branches'} and cannot be deleted.`;
      if (!valid.length) { vscode.window.showWarningMessage(msg); return; }
      vscode.window.showInformationMessage(`${msg} The other branches are deleted.`);
    }
    if (!valid.length) { return; }
    // Ramas locales que siguen a alguna de las remotas y no están ya en la selección
    const chosen = new Set(valid.filter(p => p.type === 'local').flatMap(p => p.repos.map(i => `${i}:${p.name}`)));
    const tracked: { repo: Repo; name: string }[] = [];
    for (const p of valid.filter(x => x.type === 'remote')) {
      for (const r of this.reposOf(p.repos)) {
        for (const l of r.refs) {
          if (l.type === 'local' && l.upstream === p.name && !chosen.has(`${r.idx}:${l.name}`) && !tracked.some(t => t.repo === r && t.name === l.name)) {
            tracked.push({ repo: r, name: l.name });
          }
        }
      }
    }
    const one = valid.length === 1 ? valid[0] : null;
    const multi = this.repos.length > 1;
    const repoNames = (p: RefPayload) => this.reposOf(p.repos).filter(r => r.refs.some(x => x.full === p.full)).map(r => r.name);
    const title = !one ? `Delete ${valid.length} branches?`
      : one.type === 'remote' ? `Delete remote branch '${one.name}'?` : `Delete branch '${one.name}'?`;
    // Contenido de la ventana: notas (párrafos) y secciones con un título y una lista
    const notes: string[] = [];
    const sections: { label: string; items: string[] }[] = [];
    const deletable = tracked.filter(t => t.repo.head.branch !== t.name);
    if (one) {
      const names = repoNames(one);
      if (one.type === 'remote') {
        const { remote, branch } = splitRemoteRef(one.name, this.reposOf(one.repos)[0].remotes);
        notes.push(`The branch is deleted on the remote: git push ${remote} --delete ${branch}`);
        if (multi) { sections.push({ label: names.length === 1 ? 'In this repository:' : `In these ${names.length} repositories:`, items: names }); }
      } else if (multi) {
        sections.push({ label: names.length === 1 ? 'In this repository:' : `In these ${names.length} repositories:`, items: names });
      }
    } else {
      // Varias ramas: una línea por rama, con sus repos
      sections.push({ label: 'Branches:', items: valid.map(p => `${p.type === 'remote' ? 'remote ' : ''}'${p.name}'${multi ? ` — ${repoNames(p).join(', ')}` : ''}`) });
      if (valid.some(p => p.type === 'remote')) { notes.push('Remote branches are deleted on the remote.'); }
    }
    // Locales con rama en el remoto: solo se informa, la remota no se toca. Se agrupan por
    // «local → remota»; si es en todos los repos de la rama, basta una línea sin lista
    const twins = new Map<string, string[]>();
    for (const p of valid.filter(x => x.type === 'local')) {
      for (const r of this.reposOf(p.repos)) {
        const up = r.refs.find(x => x.type === 'local' && x.name === p.name)?.upstream;
        if (up && r.refs.some(x => x.type === 'remote' && x.name === up) && !valid.some(v => v.type === 'remote' && v.name === up && v.repos.includes(r.idx))) {
          const k = `'${p.name}' → '${up}'`;
          twins.set(k, [...(twins.get(k) ?? []), r.name]);
        }
      }
    }
    if (twins.size) {
      const allOf = one ? repoNames(one) : [];
      const [k, rs] = [...twins.entries()][0];
      if (one && twins.size === 1 && (!multi || rs.length === allOf.length)) {
        notes.push(`It also exists on the remote as ${k.split(' → ')[1]}${multi && rs.length > 1 ? ` (in all of them)` : ''}.`, 'Only the local branch is deleted.');
      } else {
        sections.push({ label: 'Also on the remote (only the local branch is deleted):', items: [...twins.entries()].map(([t, r]) => `${t}${multi ? ` — ${r.join(', ')}` : ''}`) });
      }
    }
    // Las locales que son la rama actual no se pueden borrar: solo se avisa
    const kept = tracked.filter(t => t.repo.head.branch === t.name);
    if (kept.length) {
      notes.push(`Tracked by the current branch ${kept.map(t => `'${t.name}'${multi ? ` (${t.repo.name})` : ''}`).join(', ')}, which will be kept.`);
    }
    // Siempre el mismo diálogo en el panel (como JetBrains); la casilla, solo si alguna local
    // sigue a una de las remotas que se borran, con la lista de dónde se borraría
    const localNames = [...new Set(deletable.map(t => t.name))];
    // Si la local se borraría justo en los mismos repos que la remota, no se repite la lista
    const sameRepos = !!one && localNames.length === 1 && deletable.length === repoNames(one).length;
    const cbWhere = multi && sameRepos && deletable.length > 1 ? ` in all ${deletable.length} repositories` : '';
    const res = await this.confirmInPanel({
      heading: title, notes, sections, action: 'Delete',
      checkbox: deletable.length ? `Delete tracked local branch${localNames.length === 1 ? '' : 'es'} ${localNames.map(n => `'${n}'`).join(', ')}${cbWhere}` : '',
      checkboxItems: deletable.length && multi && !sameRepos ? deletable.map(t => (localNames.length > 1 ? `'${t.name}' — ${t.repo.name}` : t.repo.name)) : [],
    });
    if (!res?.ok) { return; }
    const alsoLocal = deletable.length > 0 && !!res.checked;

    const errors: string[] = [];
    const many = valid.length + (alsoLocal ? deletable.length : 0) > 1;
    const attempt = async (label: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (e: any) { errors.push(many ? `${label}: ${e.message}` : e.message); }
    };
    for (const p of valid) { await attempt(p.name, () => this.deleteBranch(p)); }
    if (alsoLocal) {
      for (const t of deletable) { await attempt(t.name, () => this.deleteLocal(t.repo, t.name)); }
    }
    if (errors.length) { throw new Error(errors.join('\n')); }
  }

  /** Borra una rama local; si no está mergeada, pregunta antes de forzarlo. */
  private async deleteLocal(r: Repo, name: string) {
    if (r.head.branch === name) { throw new Error(`'${name}' is the current branch${this.inRepos([r])}.`); }
    try {
      await r.git.run(['branch', '-d', name]);
    } catch (e: any) {
      if (!/not fully merged/i.test(e.message)) { throw e; }
      // Como git: con upstream se compara con él; si no, con la rama actual (HEAD)
      const up = r.refs.find(x => x.type === 'local' && x.name === name)?.upstream;
      const base = up && r.refs.some(x => x.type === 'remote' && x.name === up) ? up : (r.head.branch || 'HEAD');
      const MAX = 20;
      const out = await r.git.run(['log', `-n${MAX + 1}`, '--format=%h  %s', `${base}..refs/heads/${name}`]).catch(() => '');
      const commits = out.split('\n').filter(Boolean);
      const items = commits.slice(0, MAX).concat(commits.length > MAX ? ['…'] : []);
      const into = base === 'HEAD' ? 'the current HEAD' : `'${base}'`;
      if (await this.confirm(`Branch '${name}' is not fully merged${this.inRepos([r])}`,
        `Its commits are not in ${into}${base === up ? ' (its remote branch)' : ' (the current branch)'}. If you delete it, they may be lost.`,
        'Delete Anyway',
        items.length ? [{ label: commits.length > MAX ? `Unmerged commits (latest ${MAX}):` : `Unmerged commit${commits.length === 1 ? '' : 's'}:`, items, icon: 'commit' }] : [])) {
        await r.git.run(['branch', '-D', name]);
      }
    } finally {
      this.scheduleRefresh();
    }
  }

  // ----- pestaña Settings ------------------------------------------------------------

  /** Ajustes de la extensión (jbGit.*) que se editan desde la pestaña Settings. */
  postSettings() {
    const c = vscode.workspace.getConfiguration('jbGit');
    this.post({
      type: 'settings',
      values: {
        dateFormat: c.get<string>('dateFormat', 'absolute'),
        maxCommits: commitsPerPage(c),
        repositoryScanMaxDepth: scanDepth(c),
        autoStage: c.get<boolean>('autoStage', true),
        protectedBranches: c.get<string[]>('protectedBranches', ['main', 'master']),
        folderColors: c.get<Record<string, string>>('folderColors', DEFAULT_FOLDER_COLORS),
        branchColors: c.get<Record<string, string>>('branchColors', {}),
        tagColor: c.get<string>('tagColor', 'yellow'),
        shortcuts: c.get<Record<string, string>>('shortcuts', {}),
        ...fontSettings(),
      },
    });
  }

  /** Guarda un ajuste en la configuración de usuario; solo los conocidos y con valores válidos. */
  private async setSetting(key: string, value: any) {
    const v = validateSetting(key, value);
    if (v === undefined) { this.postSettings(); return; }
    await vscode.workspace.getConfiguration('jbGit').update(key, v, vscode.ConfigurationTarget.Global);
  }

  /**
   * Color del carril que empieza en un commit, según la rama que apunta a él: el elegido
   * por el usuario (jbGit.branchColors) o uno fijo sacado del nombre. Así una rama tiene el
   * mismo color en todos los repos y en cada recarga. Las remotas cuentan por su nombre sin
   * el remoto (origin/x → x). Si varias ramas apuntan al commit, manda la filtrada, luego la
   * actual del repo, luego las locales y luego las remotas.
   */
  private branchColorFn(included: Repo[]): (id: string) => GraphColor | undefined {
    const custom = vscode.workspace.getConfiguration('jbGit').get<Record<string, string>>('branchColors', {});
    const filtered = this.filterRef && this.filterRef !== 'HEAD'
      ? this.filterRef.slice(this.filterRef.indexOf('|') + 1) : '';
    const best = new Map<string, { name: string; rank: number }>();
    for (const r of included) {
      for (const x of r.refs) {
        if (x.type === 'tag') { continue; }
        const name = x.type === 'remote' ? (x.branch ?? splitRemoteRef(x.name, r.remotes).branch) : x.name;
        if (!name || name === 'HEAD') { continue; }
        const rank = x.full === filtered ? 0 : x.type === 'local' && x.name === r.head.branch ? 1 : x.type === 'local' ? 2 : 3;
        const id = r.id(x.hash);
        const cur = best.get(id);
        if (!cur || rank < cur.rank) { best.set(id, { name, rank }); }
      }
    }
    return id => {
      const b = best.get(id);
      if (!b) { return undefined; }
      const c = custom[b.name];
      return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : autoBranchColor(b.name);
    };
  }

  /**
   * Rama remota protegida: su nombre sin el remoto (origin/main → main) está en
   * jbGit.protectedBranches (main y master por defecto) en alguno de sus repos.
   */
  private isProtectedRemote(full: string, repos: number[]): boolean {
    const names = vscode.workspace.getConfiguration('jbGit').get<string[]>('protectedBranches', ['main', 'master']);
    return this.reposOf(repos).some(r => {
      const ref = r.refs.find(x => x.full === full && x.type === 'remote');
      return !!ref && names.includes(ref.branch ?? '');
    });
  }

  /** Borra una rama (local o remota) en sus repos, sin la confirmación general. */
  private async deleteBranch(payload: RefPayload) {
    if (payload.type === 'remote' && this.isProtectedRemote(payload.full, payload.repos)) {
      throw new Error(`'${payload.name}' is a protected branch and cannot be deleted.`);
    }
    const repos = this.reposOf(payload.repos).filter(r => r.refs.some(x => x.full === payload.full));
    if (!repos.length) { return; }
    const name = payload.name;
    if (payload.type === 'local') {
      return this.forEachRepo(repos, r => this.deleteLocal(r, name));
    }
    if (payload.type === 'remote') {
      return this.forEachRepo(repos, r => {
        // Remoto y rama de la ref de ese repo (los remotos con «/» los resuelve getRefs)
        const ref = r.refs.find(x => x.full === payload.full)!;
        const { remote, branch } = ref.remote && ref.branch ? { remote: ref.remote, branch: ref.branch } : splitRemoteRef(name, r.remotes);
        return this.exec(r, ['push', remote, '--delete', `refs/heads/${branch}`], `Deleting '${name}'…`);
      });
    }
  }

  // ----- ventana de Push (como la de JetBrains) --------------------------------------

  /**
   * Commits que subiría un push de branch a remote/target: los que no están en esa rama
   * remota o, si aún no existe, en ninguna rama de ese remoto. behind: commits de la rama
   * remota que no están en la local (el push se rechazaría sin Force Push).
   */
  private async pushCommits(repo: Repo, branch: string, remote: string, target: string) {
    if (!remote || !branch) { return { commits: [], behind: 0, exists: false }; }
    const remoteRef = `refs/remotes/${remote}/${target}`;
    const exists = repo.refs.some(x => x.full === remoteRef);
    const range = exists ? [`${remoteRef}..refs/heads/${branch}`] : [`refs/heads/${branch}`, '--not', `--remotes=${remote}`];
    const out = await repo.git.run(['log', '-n', '500', '--format=%H%x1f%P%x1f%s%x1f%an%x1f%at', ...range, '--']).catch(() => '');
    const commits = out.split('\n').filter(Boolean).map(l => {
      const [hash, parents, subject, author, time] = l.split('\x1f');
      const parent = parents.split(' ')[0];
      return { hash: repo.id(hash), sha: hash, parent: parent ? repo.id(parent) : null, subject, author, time: Number(time) };
    });
    const behind = exists
      ? Number((await repo.git.run(['rev-list', '--count', `refs/heads/${branch}..${remoteRef}`]).catch(() => '0')).trim()) || 0
      : 0;
    return { commits, behind, exists };
  }

  /** Ramas protegidas (jbGit.protectedBranches): no admiten Force Push. */
  private protectedNames(): string[] {
    return vscode.workspace.getConfiguration('jbGit').get<string[]>('protectedBranches', ['main', 'master']);
  }

  /**
   * Ventana de Push del webview: un bloque por rama (repo, rama → remoto : rama de destino,
   * editables) con los commits que se suben y sus archivos; Push Tags; Push o Force Push
   * (--force-with-lease, nunca a una rama protegida). Lo que se marque se sube repo a repo.
   */
  private async push(targets: { repo: Repo; ref: Ref }[]) {
    targets = targets.filter(t => t.ref && t.ref.type === 'local');
    if (!targets.length) { vscode.window.showWarningMessage('Nothing to push.'); return; }
    if (!targets.some(t => t.repo.remotes.length)) { throw new Error('No remote configured.'); }
    const items = await Promise.all(targets.map(async ({ repo, ref }, key) => {
      const up = ref.upstream ? splitRemoteRef(ref.upstream, repo.remotes) : null;
      const remote = up?.remote || repo.defaultRemote() || '';
      const target = up?.branch || ref.name;
      const p = await this.pushCommits(repo, ref.name, remote, target);
      return { key, repo: repo.idx, repoName: repo.name, branch: ref.name, remote, remotes: repo.remotes, target, hasUpstream: !!up, ...p };
    }));
    // Ventana flotante (DialogWindow); pide los commits al cambiar remoto o destino y los
    // archivos de un commit, y abre el diff de un archivo con doble clic
    const res: any = await DialogWindow.open(this.media(), {
      title: 'Push Commits',
      kind: 'push',
      data: { items, protectedBranches: this.protectedNames(), multi: this.repos.length > 1 },
      onMessage: async (m, post) => {
        if (m?.type === 'pushPreview') {
          const r = this.repo(m.repo);
          if (!r) { return; }
          const p = await this.pushCommits(r, String(m.branch ?? ''), String(m.remote ?? ''), String(m.target ?? ''));
          post({ type: 'pushPreview', key: m.key, ...p });
        } else if (m?.type === 'pushFiles') {
          const c = this.decode(m.hash);
          if (!c) { return; }
          const files = await c.repo.git.getChangedFiles(this.decode(m.parent)?.hash ?? null, c.hash);
          post({ type: 'pushFiles', hash: m.hash, files });
        } else if (m?.type === 'openFileDiff') {
          await this.openCommitFileDiff(m.hash, m.parent ?? null, m.file as FileChange, vscode.ViewColumn.One);
        }
      },
    });
    if (!res?.ok) { return; }
    const chosen = (Array.isArray(res.items) ? res.items : []).filter((x: any) => x && x.include);
    if (!chosen.length) { return; }
    const force = !!res.force;
    const tags = res.tags === 'all' ? ['--tags'] : res.tags === 'follow' ? ['--follow-tags'] : [];
    const errors: string[] = [];
    for (const c of chosen) {
      const item = items[Number(c.key)];
      if (!item) { continue; }
      const repo = this.repos[item.repo];
      const remote = String(c.remote || item.remote);
      const target = String(c.target || item.target).trim();
      const label = this.repos.length > 1 ? `${repo.name}: ${item.branch}` : item.branch;
      try {
        if (!repo.remotes.includes(remote)) { throw new Error(`Unknown remote '${remote}'.`); }
        if (!target || /\s|\.\.|^-|[~^:?*[\\]/.test(target)) { throw new Error(`'${target}' is not a valid branch name.`); }
        if (force && this.protectedNames().includes(target)) { throw new Error(`'${target}' is protected: it cannot be force-pushed.`); }
        // Sin upstream (o con otro destino) se fija como upstream, como hace JetBrains con una rama nueva
        const setUp = !item.hasUpstream;
        const args = ['push', ...(force ? ['--force-with-lease'] : []), ...tags, ...(setUp ? ['-u'] : []), remote, `refs/heads/${item.branch}:refs/heads/${target}`];
        await this.exec(repo, args, `${force ? 'Force pushing' : 'Pushing'} '${item.branch}' to ${remote}/${target}…`);
      } catch (e: any) {
        const msg = /rejected|non-fast-forward|fetch first|stale info/i.test(e.message)
          ? `rejected: ${remote}/${target} has commits that '${item.branch}' doesn't have. Update the branch first, or use Force Push.`
          : e.message;
        errors.push(chosen.length > 1 ? `${label}: ${msg}` : msg);
      }
    }
    if (errors.length) { throw new Error(errors.join('\n')); }
  }

  private async tagAction(action: string, name: string, repos: Repo[]) {
    repos = repos.filter(r => r.refs.some(x => x.type === 'tag' && x.name === name));
    if (!repos.length) { return; }
    switch (action) {
      case 'push':
        return this.forEachRepo(repos, r => {
          const remote = r.defaultRemote();
          if (!remote) { throw new Error('No remote configured.'); }
          return this.exec(r, ['push', remote, `refs/tags/${name}`], `Pushing tag '${name}'…`);
        });
      case 'delete':
        if (await this.confirm(`Delete tag '${name}'${this.inRepos(repos)}?`, 'Only the local tag is deleted.', 'Delete')) {
          return this.forEachRepo(repos, r => this.exec(r, ['tag', '-d', name]));
        }
        return;
    }
  }

  // ----- filtros del log (Paths, User, Date) ------------------------------------------

  private async setLogFilter(key: string, value: any) {
    const f = { ...this.logFilters };
    if (key === 'authors') {
      f.authors = Array.isArray(value) ? value.filter((a: any) => typeof a === 'string' && a.trim()).map((a: string) => a.trim()) : [];
    } else if (key === 'date') {
      const ok = (s: any) => typeof s === 'string' && /^[\w .:-]{1,40}$/.test(s);
      f.since = value && ok(value.since) ? value.since : undefined;
      f.until = value && ok(value.until) ? value.until : undefined;
      f.dateLabel = f.since || f.until ? String(value.label ?? '') : undefined;
    } else if (key === 'paths') {
      // { roots: raíces de repos, paths: archivos o carpetas absolutos dentro de algún repo }
      const roots = new Set(this.repos.map(r => r.root));
      f.roots = Array.isArray(value?.roots) ? value.roots.filter((r: any) => roots.has(r)) : [];
      f.paths = Array.isArray(value?.paths)
        ? value.paths.filter((p: any) => typeof p === 'string' && path.isAbsolute(p) && this.repos.some(r => !path.relative(r.root, p).startsWith('..')))
        : [];
    } else {
      return;
    }
    this.logFilters = f;
    this.extraCommits = 0;
    return this.refresh();
  }

  /** «Select…» de los filtros: pide el valor con los diálogos de VS Code. */
  private async pickLogFilter(key: string) {
    if (key === 'authors') {
      const v = await vscode.window.showInputBox({
        title: 'Filter by User',
        prompt: 'Names or emails, separated by commas. A commit matches if its author contains any of them.',
        value: this.logFilters.authors.join(', '),
      });
      if (v !== undefined) { return this.setLogFilter('authors', v.split(',').map(s => s.trim()).filter(Boolean)); }
      return;
    }
    if (key === 'date') {
      const valid = (s: string) => !s.trim() || /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? undefined : 'Use the format YYYY-MM-DD, or leave it empty';
      const since = await vscode.window.showInputBox({ title: 'Filter by Date (1/2)', prompt: 'From (YYYY-MM-DD). Leave empty for no start date.', value: this.logFilters.since && /^\d{4}/.test(this.logFilters.since) ? this.logFilters.since : '', validateInput: valid });
      if (since === undefined) { return; }
      const until = await vscode.window.showInputBox({ title: 'Filter by Date (2/2)', prompt: 'To (YYYY-MM-DD). Leave empty for no end date.', value: this.logFilters.until?.replace(/ 23:59:59$/, '') ?? '', validateInput: valid });
      if (until === undefined) { return; }
      const s = since.trim(), u = until.trim();
      const label = s && u ? `${s} – ${u}` : s ? `since ${s}` : u ? `until ${u}` : '';
      // «until» inclusivo: hasta el final de ese día
      return this.setLogFilter('date', { since: s || undefined, until: u ? `${u} 23:59:59` : undefined, label });
    }
    if (key === 'paths') {
      const picked = await vscode.window.showOpenDialog({
        title: 'Filter by Paths', openLabel: 'Filter', canSelectFiles: true, canSelectFolders: true, canSelectMany: true,
        defaultUri: vscode.Uri.file(this.repos.length === 1 ? this.repos[0].root : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.repos[0].root),
      });
      if (!picked) { return; }
      const inside = picked.map(u => u.fsPath).filter(p => this.repos.some(r => { const rel = path.relative(r.root, p); return !rel.startsWith('..') && !path.isAbsolute(rel); }));
      if (!inside.length) { vscode.window.showWarningMessage('Select files or folders inside a repository.'); return; }
      // Elegir la raíz de un repo es lo mismo que marcar ese repo
      // (con la ruta de la raíz tal como la guarda el repo, que es con la que se compara después)
      const roots = this.repos.filter(r => inside.some(p => samePath(r.root, p))).map(r => r.root);
      const paths = inside.filter(p => !roots.some(r => samePath(r, p)));
      return this.setLogFilter('paths', {
        roots: [...new Set([...this.logFilters.roots, ...roots])],
        paths: [...new Set([...this.logFilters.paths, ...paths])],
      });
    }
  }

  // ----- pestaña Local Changes ---------------------------------------------------------

  /** Repo de un cambio que manda el webview; su ruta (y la de origen) debe quedar dentro del repo. */
  private changeRepo(c: Change): Repo {
    const r = this.repo(c?.repo);
    if (!r || typeof c.path !== 'string') { throw new Error('Unknown repository.'); }
    if (!safeRepoPath(r.root, c.path) || (c.oldPath !== undefined && !safeRepoPath(r.root, c.oldPath))) {
      throw new Error(`'${c.path}' is not inside the repository.`);
    }
    return r;
  }

  private async openChange(c: Change) {
    const repo = this.changeRepo(c);
    const root = repo.root;
    const name = path.basename(c.path);
    const empty = revisionUri(root, '', c.path);
    const work = vscode.Uri.file(path.join(root, c.path));
    const opts = { preview: true, preserveFocus: true };
    switch (c.group) {
      case 'staged': {
        // HEAD ↔ índice (':0' es la versión en el índice: git show :0:ruta)
        const left = c.status === 'A' ? empty : revisionUri(root, 'HEAD', c.oldPath ?? c.path);
        const right = c.status === 'D' ? empty : revisionUri(root, ':0', c.path);
        return vscode.commands.executeCommand('vscode.diff', left, right, `${name} (HEAD ↔ Staged)`, opts);
      }
      case 'unstaged': {
        const right = c.status === 'D' ? empty : work;
        return vscode.commands.executeCommand('vscode.diff', revisionUri(root, ':0', c.path), right, `${name} (Staged ↔ Working Tree)`, opts);
      }
      default:
        return this.openWorkingFile(repo, c.path);
    }
  }

  /**
   * Resuelve un archivo en conflicto en el visor de tres columnas (MergePanel), como el
   * «Merge…» de JetBrains: izquierda lo propio (:2), derecha lo que llega (:3) y en medio
   * el resultado, partiendo de la base (:1). Si un lado borró el archivo, se pregunta si
   * mantenerlo o borrarlo; si es binario, con qué versión quedarse.
   */
  private async openMergeEditor(repo: Repo, rel: string): Promise<void> {
    const stages = new Set((await repo.git.run(['ls-files', '-u', '--', rel])).split('\n').map(l => l.split(/\s+/)[2]).filter(Boolean));
    if (!stages.size) { vscode.window.showInformationMessage(`'${rel}' has no conflicts.`); return; }
    const op = repo.op;
    const ours = op?.ours || 'HEAD', theirs = op?.theirs || 'incoming';
    const accept = (side: 'acceptOurs' | 'acceptTheirs'): Promise<void> => this.changeAction(side, [{ repo: repo.idx, path: rel, group: 'conflicts', status: 'U' } as Change]);

    // Borrado en un lado y modificado en el otro: no hay nada que mezclar línea a línea
    if (!stages.has('2') || !stages.has('3')) {
      const deletedBy = !stages.has('2') ? `yours ('${ours}')` : `theirs ('${theirs}')`;
      const keep = 'Keep Modified File', del = 'Delete File';
      const r = await vscode.window.showWarningMessage(`'${rel}' was deleted in ${deletedBy} and modified in the other side.`, { modal: true }, keep, del);
      if (!r) { return; }
      const keepSide = stages.has('2') ? 'acceptOurs' : 'acceptTheirs';
      return accept(r === keep ? keepSide : (keepSide === 'acceptOurs' ? 'acceptTheirs' : 'acceptOurs'));
    }

    const show = (n: string) => (stages.has(n) ? repo.git.run(['show', `:${n}:${rel}`]) : Promise.resolve(''));
    const [base, o, t] = await Promise.all([show('1'), show('2'), show('3')]);
    if (/\0/.test(o) || /\0/.test(t)) {
      const a = `Accept Yours ('${ours}')`, b = `Accept Theirs ('${theirs}')`;
      const r = await vscode.window.showWarningMessage(`'${rel}' is a binary file.`, { modal: true, detail: 'Choose which version to keep.' }, a, b);
      if (r) { await accept(r === a ? 'acceptOurs' : 'acceptTheirs'); }
      return;
    }
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    await MergePanel.open(media, repo.git, rel, { base, ours: o, theirs: t }, { ours, theirs },
      () => this.scheduleChanges(),
      () => this.openNativeMergeEditor(repo, rel, stages));
  }

  /** El editor de merge de VS Code (alternativa al visor propio, desde su pie). */
  private async openNativeMergeEditor(repo: Repo, rel: string, stages: Set<string>) {
    const ver = (n: string) => revisionUri(repo.root, stages.has(n) ? `:${n}` : '', rel);
    const op = repo.op;
    try {
      await vscode.commands.executeCommand('_open.mergeEditor', {
        base: ver('1'),
        input1: { uri: ver('2'), title: 'Yours', description: op?.ours ?? 'HEAD' },
        input2: { uri: ver('3'), title: 'Theirs', description: op?.theirs ?? '' },
        output: vscode.Uri.file(path.join(repo.root, rel)),
      });
    } catch {
      await this.openWorkingFile(repo, rel);
    }
  }

  /**
   * Continue / Skip / Abort de la operación a medias de un repo (rebase, merge, cherry-pick
   * o revert). Continue no abre editor (core.editor=true: se queda el mensaje que propone
   * git). Abort y Skip piden confirmación porque descartan trabajo.
   */
  private async opAction(repo: Repo | undefined, action: string) {
    if (!repo) { return; }
    const op = repo.op ?? await repo.git.getOperation();
    if (!op) { this.scheduleRefresh(); return; }
    const what = op.kind;
    const where = this.inRepos([repo]);
    if (action === 'abort') {
      const detail = op.kind === 'rebase' ? `'${op.theirs}' goes back to how it was before the rebase.`
        : op.kind === 'merge' ? 'The changes of the merge are discarded and the branch goes back to how it was.'
        : `The changes of the ${what} are discarded.`;
      if (!(await this.confirm(`Abort ${what}${where}?`, detail, 'Abort'))) { return; }
    } else if (action === 'skip') {
      if (op.kind === 'merge') { return; }
      if (!(await this.confirm(`Skip this commit${where}?`, `The commit being applied is left out of the ${what}.`, 'Skip'))) { return; }
    } else if (action !== 'continue') {
      return;
    }
    try {
      await this.exec(repo, ['-c', 'core.editor=true', op.kind, `--${action}`],
        `${action === 'continue' ? 'Continuing' : action === 'skip' ? 'Skipping' : 'Aborting'} ${what}…`);
    } catch (e: any) {
      // Al seguir, el siguiente commit puede tener conflictos: es lo esperado, no un error
      if (/CONFLICT|could not apply|after resolving the conflicts/i.test(e.message)) {
        vscode.window.showWarningMessage(`The ${what} stopped again with conflicts${where}. Resolve them in Local Changes and click Continue.`);
        return;
      }
      if (/nothing to commit|No changes - did you forget/i.test(e.message) && op.kind !== 'merge') {
        vscode.window.showWarningMessage(`Nothing left to commit in this step${where}: use Skip to leave it out.`);
        return;
      }
      throw e;
    } finally {
      this.scheduleChanges();
    }
  }

  /**
   * Vista previa de un cambio en la propia pestaña: diff unificado para staged y
   * unstaged, y el contenido del archivo para los sin seguimiento y los conflictos.
   */
  private async sendChangePreview(c: Change) {
    const repo = this.repo(c?.repo);
    if (!repo || !safeRepoPath(repo.root, c.path)) { return; }
    const key = `${repo.idx}:${c.group}:${c.path}`;
    const MAX = 2_000_000; // caracteres; el webview además limita las líneas que pinta
    try {
      if (c.group === 'staged' || c.group === 'unstaged') {
        const args = ['diff', '--no-color', '--no-ext-diff', '-M'];
        if (c.group === 'staged') { args.push('--cached'); }
        args.push('--', ...(c.oldPath ? [c.oldPath, c.path] : [c.path]));
        const text = await repo.git.run(args);
        this.post({ type: 'changePreview', key, kind: 'diff', text: text.slice(0, MAX), truncated: text.length > MAX });
        return;
      }
      const buf = await fs.readFile(safeRepoPath(repo.root, c.path)!);
      if (buf.subarray(0, 8000).includes(0)) {
        this.post({ type: 'changePreview', key, kind: 'file', binary: true, text: '' });
        return;
      }
      const text = buf.toString('utf8');
      this.post({ type: 'changePreview', key, kind: 'file', text: text.slice(0, MAX), truncated: text.length > MAX });
    } catch (e: any) {
      this.post({ type: 'changePreview', key, error: e.message });
    }
  }

  /**
   * Añade patrones al .gitignore de la raíz de cada repo (se versiona) o a su
   * .git/info/exclude (solo local). No repite los que ya están.
   */
  private async addIgnore(target: 'gitignore' | 'exclude', items: { repo: number; pattern: string }[]) {
    const byRepo = new Map<Repo, string[]>();
    for (const it of items) {
      const r = this.repo(it?.repo);
      if (!r || typeof it.pattern !== 'string' || !it.pattern.trim() || /[\r\n]/.test(it.pattern)) { continue; }
      byRepo.set(r, [...(byRepo.get(r) ?? []), it.pattern]);
    }
    let added = 0;
    try {
      for (const [repo, patterns] of byRepo) {
        const file = target === 'gitignore'
          ? path.join(repo.root, '.gitignore')
          : path.resolve(repo.root, (await repo.git.run(['rev-parse', '--git-path', 'info/exclude'])).trim());
        let current = '';
        try { current = await fs.readFile(file, 'utf8'); } catch { /* todavía no existe */ }
        const existing = new Set(current.split(/\r?\n/).map(l => l.trim()));
        const add = [...new Set(patterns)].filter(p => !existing.has(p));
        if (!add.length) { continue; }
        const eol = current.includes('\r\n') ? '\r\n' : '\n';
        const prefix = current && !current.endsWith('\n') ? eol : '';
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, current + prefix + add.join(eol) + eol, 'utf8');
        added += add.length;
      }
    } finally {
      this.scheduleChanges();
    }
    const where = target === 'gitignore' ? '.gitignore' : '.git/info/exclude';
    vscode.window.setStatusBarMessage(added ? `$(check) Added ${added} ${added === 1 ? 'pattern' : 'patterns'} to ${where}` : `Already in ${where}`, 3000);
  }

  /**
   * Stage o unstage de un solo bloque de la vista previa (como el commit parcial de
   * JetBrains). En Changes, el bloque del diff índice ↔ árbol de trabajo se aplica al índice
   * (`git apply --cached`, parche 'forward'); en Staged, el del diff HEAD ↔ índice se quita
   * del índice (`git apply --cached -R`). El árbol de trabajo no cambia. Tras un unstage el
   * archivo queda excluido del auto-stage (como con «−»), para que no se vuelva a añadir entero.
   */
  private async stageBlock(c: Change, block: number, lines: string[]) {
    const repo = this.changeRepo(c);
    const git = repo.git;
    if ((c.group !== 'staged' && c.group !== 'unstaged') || c.status === 'D' || !Number.isInteger(block)) { return; }
    const staged = c.group === 'staged';
    const args = ['diff', '--no-color', '--no-ext-diff', '-M'];
    if (staged) { args.push('--cached'); }
    args.push('--', ...(c.oldPath ? [c.oldPath, c.path] : [c.path]));
    const diff = await git.run(args);
    if (JSON.stringify(parseDiffBlocks(diff).blocks[block]) !== JSON.stringify(lines)) {
      this.scheduleChanges();
      throw new Error('The file has changed since the preview was shown. Try again.');
    }
    const patch = buildBlockPatch(diff, block, c.path, staged ? 'reverse' : 'forward');
    if (!patch) { return; }
    // Se excluye antes de tocar el índice: si el watcher refresca entre medias, el
    // auto-stage no debe volver a añadir el archivo entero
    const before = this.getExcluded(repo);
    if (staged) { await this.setExcluded(repo, [...before, c.path]); }
    try {
      await git.run(['apply', '--cached', ...(staged ? ['-R'] : []), '--whitespace=nowarn', '-'], patch);
    } catch (e: any) {
      if (staged) { await this.setExcluded(repo, before); }
      throw new Error(`Could not ${staged ? 'unstage' : 'stage'} this change: ${e.message}`);
    } finally {
      this.scheduleChanges();
    }
  }

  /**
   * Rollback de un solo bloque de la vista previa: se genera un parche con ese bloque
   * y se aplica al revés. En Changes solo toca el árbol de trabajo; en Staged, el
   * índice y el árbol de trabajo (si no, el auto-stage lo volvería a añadir).
   */
  private async rollbackBlock(c: Change, block: number, lines: string[]) {
    const repo = this.changeRepo(c);
    const git = repo.git;
    if ((c.group !== 'staged' && c.group !== 'unstaged') || c.status === 'D' || !Number.isInteger(block)) { return; }
    const args = ['diff', '--no-color', '--no-ext-diff', '-M'];
    if (c.group === 'staged') { args.push('--cached'); }
    args.push('--', ...(c.oldPath ? [c.oldPath, c.path] : [c.path]));
    const diff = await git.run(args);
    // El bloque pedido debe ser exactamente el que se veía: si el archivo ha cambiado, no se toca
    if (JSON.stringify(parseDiffBlocks(diff).blocks[block]) !== JSON.stringify(lines)) {
      this.scheduleChanges();
      throw new Error('The file has changed since the preview was shown. Try again.');
    }
    const patch = buildBlockPatch(diff, block, c.path);
    if (!patch) { return; }
    const apply = (extra: string[]) => git.run(['apply', '-R', '--whitespace=nowarn', ...extra, '-'], patch);
    try {
      if (c.group === 'unstaged') {
        await apply([]);
      } else {
        const unstagedToo = (await git.getStatus()).some(x => x.group === 'unstaged' && x.path === c.path);
        if (!unstagedToo) {
          await apply(['--index']);
        } else {
          // El árbol de trabajo tiene más cambios: se comprueban ambos antes de tocar nada
          await apply(['--check']);
          await apply(['--cached', '--check']);
          await apply([]);
          await apply(['--cached']);
        }
      }
    } catch (e: any) {
      throw new Error(`Could not roll back this change: ${e.message}`);
    } finally {
      this.scheduleChanges();
    }
  }

  /** Agrupa cambios por repositorio (cada uno trae su índice de repo). */
  private byRepo(changes: Change[]): Map<Repo, Change[]> {
    const m = new Map<Repo, Change[]>();
    for (const c of changes) {
      const r = this.repo(c?.repo);
      if (!r || typeof c.path !== 'string') { continue; }
      m.set(r, [...(m.get(r) ?? []), c]);
    }
    return m;
  }

  private async changeAction(action: string, changes: Change[]): Promise<void> {
    const groups = this.byRepo(changes);
    if (!groups.size) { return; }
    const paths = (cs: Change[]) => [...new Set(cs.flatMap(c => c.oldPath ? [c.path, c.oldPath] : [c.path]))];
    const count = (cs: Change[]) => {
      const ps = [...new Set(cs.map(c => `${c.repo}:${c.path}`))];
      return ps.length === 1 ? `'${path.basename(cs[0].path)}'` : `${ps.length} files`;
    };
    const repos = [...groups.keys()];
    try {
      switch (action) {
        case 'open':
          for (const [repo, cs] of groups) { for (const c of cs) { await this.openWorkingFile(repo, c.path); } }
          return;

        case 'stage':
          return await this.locked(() => this.forEachRepo(repos, async repo => {
            const ps = paths(groups.get(repo)!);
            const excluded = this.getExcluded(repo);
            ps.forEach(p => excluded.delete(p));
            await this.setExcluded(repo, excluded);
            await repo.git.run(['add', '-A', '--', ...ps]);
          }));

        case 'unstage':
          // Se recuerdan para que el auto-stage no los vuelva a añadir
          return await this.locked(() => this.forEachRepo(repos, async repo => {
            const ps = paths(groups.get(repo)!);
            await this.setExcluded(repo, [...this.getExcluded(repo), ...ps]);
            await repo.git.run(['reset', '-q', '--', ...ps]);
          }));

        // Conflictos: quedarse con una versión entera (la del lado que la borró → se borra)
        case 'acceptOurs':
        case 'acceptTheirs':
          return await this.locked(() => this.forEachRepo(repos, async repo => {
            const side = action === 'acceptOurs' ? '--ours' : '--theirs';
            for (const p of paths(groups.get(repo)!)) {
              try {
                await repo.git.run(['checkout', side, '--', p]);
                await repo.git.run(['add', '--', p]);
              } catch (e: any) {
                if (!/does not have (our|their) version/i.test(e.message)) { throw e; }
                await repo.git.run(['rm', '-q', '--', p]);
              }
            }
          }));

        case 'merge': {
          const [repo, cs] = [...groups][0];
          return await this.openMergeEditor(repo, cs[0].path);
        }

        case 'rollback': {
          const all = changes.filter(c => c.group === 'staged' || c.group === 'unstaged');
          if (!all.length) { return; }
          const ok = await this.confirm(`Rollback ${count(all)}${this.inRepos(repos)}?`,
            'Local changes in these files will be lost. Added files are unstaged and kept as unversioned files.', 'Rollback');
          if (!ok) { return; }
          return await this.locked(() => this.forEachRepo(repos, async repo => {
            const cs = groups.get(repo)!;
            const staged = cs.filter(c => c.group === 'staged');
            const stagedPaths = new Set(staged.map(c => c.path));
            const unstaged = cs.filter(c => c.group === 'unstaged' && !stagedPaths.has(c.path));
            if (staged.length) {
              // Al estado de HEAD, índice y árbol de trabajo
              await repo.git.run(['reset', '-q', '--', ...paths(staged)]);
              const restore = staged.filter(c => c.status !== 'A').map(c => c.oldPath ?? c.path);
              if (restore.length) { await repo.git.run(['checkout', 'HEAD', '--', ...restore]); }
            }
            if (unstaged.length) {
              // Solo lo que no está en el índice
              await repo.git.run(['checkout', '--', ...unstaged.map(c => c.path)]);
            }
          }));
        }

        case 'delete': {
          // Solo archivos sin seguimiento (como el menú): los demás se deshacen con Rollback
          const untracked = changes.filter(c => c.group === 'untracked');
          if (!untracked.length) { return; }
          if (!(await this.confirm(`Delete ${count(untracked)}${this.inRepos(repos)}?`, 'Unversioned files are moved to the trash.', 'Delete'))) { return; }
          for (const [repo, cs] of groups) {
            for (const c of cs) {
              if (c.group !== 'untracked') { continue; }
              const abs = safeRepoPath(repo.root, c.path);
              if (abs) { await vscode.workspace.fs.delete(vscode.Uri.file(abs), { useTrash: true }); }
            }
          }
          return;
        }
      }
    } finally {
      this.scheduleChanges();
    }
  }

  /**
   * Commit en cada repo que tiene cambios en stage, con el mismo mensaje, como hace
   * JetBrains. Con Amend se corrige el último commit de esos repos.
   */
  private async commit(message: string, amend: boolean, push: boolean) {
    const msg = message.trim();
    if (!msg && !amend) { vscode.window.showWarningMessage('Enter a commit message.'); return; }
    // Con auto-stage, primero se añade lo que haya cambiado desde el último refresco: lo que
    // la lista de Local Changes da por incluido tiene que entrar en el commit
    const auto = vscode.workspace.getConfiguration('jbGit').get<boolean>('autoStage', true);
    const status = await this.locked(() => Promise.all(this.repos.map(async r => {
      const st = await r.git.getStatus();
      return { r, files: auto ? await this.autoStage(r, st) : st };
    })));
    const conflicted = status.filter(s => s.files.some(c => c.group === 'conflicts'));
    if (conflicted.length) {
      vscode.window.showWarningMessage(`Resolve the merge conflicts before committing${this.inRepos(conflicted.map(s => s.r))}.`);
      return;
    }
    let targets = status.filter(s => s.files.some(c => c.group === 'staged')).map(s => s.r);
    if (!targets.length) {
      if (amend && this.repos.length === 1) {
        targets = [this.repos[0]];
      } else if (amend) {
        vscode.window.showWarningMessage('Stage the changes to amend: the last commit is amended only in repositories with staged changes.');
        return;
      } else {
        const withChanges = status.filter(s => s.files.length).map(s => s.r);
        if (!withChanges.length) { vscode.window.showInformationMessage('Nothing to commit.'); return; }
        const ok = await this.confirm('There are no staged changes.', `Stage all changes, including unversioned files, and commit them${this.inRepos(withChanges)}?`, 'Stage All and Commit');
        if (!ok) { return; }
        await this.locked(async () => { for (const r of withChanges) { await r.git.run(['add', '-A']); } });
        targets = withChanges;
      }
    }
    const args = ['commit'];
    if (amend) { args.push('--amend'); }
    if (msg) { args.push('-m', msg); } else { args.push('--no-edit'); }
    const done: Repo[] = [];
    try {
      await this.locked(() => this.forEachRepo(targets, async r => {
        await this.exec(r, args, amend ? 'Amending last commit…' : 'Committing…');
        done.push(r);
      }));
    } finally {
      if (done.length) { this.post({ type: 'committed' }); }
    }
    if (push) {
      const targets: { repo: Repo; ref: Ref }[] = [];
      for (const r of done) {
        r.head = await r.git.getHead();
        r.refs = await r.git.getRefs(r.remotes);
        const cur = r.currentRef();
        if (cur) { targets.push({ repo: r, ref: cur }); }
      }
      if (!targets.length) { throw new Error('Cannot push: HEAD is detached.'); }
      await this.push(targets);
    }
  }

  // ----- pestaña Stash ---------------------------------------------------------------

  private async sendStashFiles(id: string) {
    const d = this.decode(id);
    if (!d) { return; }
    try {
      this.post({ type: 'stashFiles', id, files: await d.repo.git.getStashFiles(d.hash) });
    } catch (e: any) {
      this.post({ type: 'stashFiles', id, files: [], error: e.message });
    }
  }

  private async openStashDiff(id: string, f: StashFile) {
    const d = this.decode(id);
    if (!d) { return; }
    const root = d.repo.root, hash = d.hash;
    const empty = revisionUri(root, '', f.path);
    let left: vscode.Uri, right: vscode.Uri;
    if (f.untracked) {
      left = empty;
      right = revisionUri(root, `${hash}^3`, f.path);
    } else {
      left = f.status === 'A' ? empty : revisionUri(root, `${hash}^1`, f.oldPath ?? f.path);
      right = f.status === 'D' ? empty : revisionUri(root, hash, f.path);
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(f.path)} (base ↔ stash ${hash.slice(0, 8)})`, { preview: true, preserveFocus: true });
  }

  private async stashAction(action: string, id: string, ref: string) {
    if (action === 'clear') {
      const withStashes: Repo[] = [];
      for (const r of this.repos) { if ((await r.git.getStashes()).length) { withStashes.push(r); } }
      if (!withStashes.length) { return; }
      if (await this.confirm(`Clear all stashes${this.inRepos(withStashes)}?`, 'Every stash will be deleted. This cannot be undone.', 'Clear')) {
        await this.forEachRepo(withStashes, r => this.exec(r, ['stash', 'clear'], 'Clearing stashes…'));
      }
      return;
    }
    const d = this.decode(id);
    if (!d || !/^stash@\{\d+\}$/.test(ref)) { return; }
    const { repo, hash } = d;
    // Los índices stash@{n} se desplazan al borrar otros: comprobamos que sigue siendo el mismo
    const current = (await repo.git.run(['rev-parse', ref])).trim();
    if (current !== hash) {
      await this.refreshStashes();
      throw new Error('The stash list has changed. Select the stash again.');
    }
    switch (action) {
      case 'pop':
        return this.exec(repo, ['stash', 'pop', '--index', ref], `Popping ${ref}…`).catch(e => this.retryWithoutIndex(repo, e, 'pop', ref));
      case 'apply':
        return this.exec(repo, ['stash', 'apply', '--index', ref], `Applying ${ref}…`).catch(e => this.retryWithoutIndex(repo, e, 'apply', ref));
      case 'drop': {
        if (!(await this.confirm(`Drop ${ref}${this.inRepos([repo])}?`, 'The stashed changes will be lost.', 'Drop'))) { return; }
        // Mientras el cuadro estaba abierto la lista ha podido cambiar (un pop en la terminal…):
        // se busca de nuevo por su hash, que es lo que se confirmó
        const now = (await repo.git.getStashes()).find(s => s.hash === hash);
        if (!now) {
          await this.refreshStashes();
          throw new Error('The stash no longer exists.');
        }
        return this.exec(repo, ['stash', 'drop', now.ref], `Dropping ${now.ref}…`);
      }
    }
  }

  /** `--index` restaura también lo que estaba en stage; si choca con el índice actual, se aplica sin él. */
  private async retryWithoutIndex(repo: Repo, e: any, cmd: 'pop' | 'apply', ref: string) {
    if (!/Try without --index/i.test(String(e?.message))) { throw e; }
    await this.exec(repo, ['stash', cmd, ref], `${cmd === 'pop' ? 'Popping' : 'Applying'} ${ref}…`);
  }

  // ----- acciones generales (barra de la izquierda) ---------------------------------

  private async repoAction(action: string, changes: Change[] = []) {
    switch (action) {
      case 'fetch': {
        const repos = this.repos.filter(r => r.remotes.length);
        if (!repos.length) { vscode.window.showWarningMessage('No remote configured.'); return; }
        return this.forEachRepo(repos, r => this.exec(r, ['fetch', '--all', '--prune'], 'Fetching…'));
      }

      case 'pull': {
        // Cada repo trae los cambios de su rama actual, si tiene upstream
        const repos = this.repos.filter(r => r.head.branch && r.currentRef()?.upstream);
        if (!repos.length) {
          vscode.window.showWarningMessage(this.repos.length === 1 && !this.repos[0].head.branch
            ? 'Cannot pull: HEAD is detached.' : 'The current branch has no upstream branch to pull from.');
          return;
        }
        return this.forEachRepo(repos, r => this.pull(r));
      }

      case 'push': {
        // La rama actual de cada repo (la ventana marca solo las que tienen algo que subir)
        const targets = this.repos.filter(r => r.currentRef()).map(r => ({ repo: r, ref: r.currentRef()! }));
        if (!targets.length) { vscode.window.showWarningMessage('Cannot push: HEAD is detached.'); return; }
        return this.push(targets);
      }

      case 'stash': {
        // Con archivos seleccionados solo se guardan esos; si no, todo lo de cada repo con cambios.
        // En un renombrado git no acepta la ruta antigua como pathspec: se pasa la nueva y
        // luego se recupera la antigua.
        const selected = this.byRepo(changes);
        const repos = selected.size ? [...selected.keys()] : [];
        if (!selected.size) {
          for (const r of this.repos) { if ((await r.git.run(['status', '--porcelain'])).trim()) { repos.push(r); } }
        }
        if (!repos.length) { vscode.window.showInformationMessage('No local changes to stash.'); return; }
        const nFiles = new Set(changes.map(c => `${c.repo}:${c.path}`)).size;
        const what = !selected.size ? 'all local changes' : nFiles === 1 ? `'${path.basename(changes[0].path)}'` : `${nFiles} selected files`;
        const msg = await vscode.window.showInputBox({
          title: `Stash ${what}${this.inRepos(repos)}`,
          prompt: 'Message (optional). Untracked files are included.',
          placeHolder: `WIP on ${repos[0].head.branch || 'HEAD'}`,
        });
        if (msg === undefined) { return; }
        return this.forEachRepo(repos, async r => {
          const cs = selected.get(r) ?? [];
          const files = [...new Set(cs.map(c => c.path))];
          const renamedFrom = cs.filter(c => c.group === 'staged' && c.oldPath).map(c => c.oldPath!);
          const args = ['stash', 'push', '--include-untracked'];
          if (msg.trim()) { args.push('-m', msg.trim()); }
          if (files.length) { args.push('--', ...files); }
          await this.exec(r, args, `Stashing ${what}…`);
          if (renamedFrom.length) {
            await r.git.run(['checkout', 'HEAD', '--', ...renamedFrom]);
            this.scheduleChanges();
          }
        });
      }

      case 'newBranch': {
        // Desde HEAD en todos los repos del log, como hace JetBrains
        const repos = this.includedRepos();
        const from = repos.length === 1 ? repos[0].head.branch || repos[0].head.hash.slice(0, 8) : 'HEAD';
        const n = await this.askName(`New branch from '${from}'${this.inRepos(repos)} (it will be checked out)`);
        if (n) { return this.forEachRepo(repos, r => this.exec(r, ['checkout', '-b', n])); }
        return;
      }
    }
  }

  private async pull(repo: Repo) {
    const current = repo.head.branch;
    try {
      await this.exec(repo, ['pull'], `Pulling '${current}'…`);
    } catch (e: any) {
      // Ramas divergentes sin pull.rebase configurado: preguntamos cómo integrar
      if (!/divergent branches|reconcile/i.test(e.message)) { throw e; }
      const how = await vscode.window.showQuickPick(
        [
          { label: 'Merge', description: 'Merge the incoming changes into the current branch', flag: '--no-rebase' },
          { label: 'Rebase', description: 'Rebase the current branch on top of the incoming changes', flag: '--rebase' },
        ],
        { title: `'${current}' and '${repo.currentRef()?.upstream}' have diverged${this.inRepos([repo])}` }
      );
      if (how) { await this.exec(repo, ['pull', how.flag], `Pulling '${current}' (${how.label.toLowerCase()})…`); }
    }
  }

  // ----- HTML ------------------------------------------------------------------------
  private getHtml(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'main.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Git Log</title>
</head>
<body${fontAttrs()}>
<div id="tabs" role="tablist">
  <button class="tab" role="tab" data-tab="changes">Local Changes <span class="tab-count" id="changes-count"></span></button>
  <button class="tab" role="tab" data-tab="stash">Stash <span class="tab-count" id="stash-count"></span></button>
  <button class="tab" role="tab" data-tab="log">Log</button>
  <button class="tab" role="tab" data-tab="settings">Settings</button>
</div>
<div id="op-bar" class="hidden" role="status"></div>
<div id="app">
  <nav id="git-actions" aria-label="Git actions"></nav>
  <div id="view-log" class="view">
  <section id="branches" class="pane">
    <div class="toolbar">
      <button class="icon-btn" id="btn-collapse" title="Hide branches" aria-label="Hide branches"></button>
      <input id="branch-search" type="text" placeholder="Search branches" spellcheck="false">
    </div>
    <div id="branch-tree" class="scroll" tabindex="0"></div>
  </section>
  <div class="splitter" data-target="branches"></div>
  <section id="log" class="pane">
    <div class="toolbar">
      <button class="icon-btn hidden" id="btn-expand" title="Show branches" aria-label="Show branches"></button>
      <div class="search">
        <input id="log-search" type="text" placeholder="Text or hash" spellcheck="false">
      </div>
      <div id="log-filters" class="filters"></div>
      <span class="spacer"></span>
      <button class="icon-btn" id="btn-log-view" title="View Options" aria-label="View Options"></button>
      <button class="icon-btn" id="btn-refresh" title="Refresh" aria-label="Refresh"></button>
      <button class="icon-btn hidden" id="btn-details-expand" title="Show details" aria-label="Show details"></button>
    </div>
    <div id="log-list" class="scroll" tabindex="0"></div>
  </section>
  <div class="splitter" data-target="details" data-side="right"></div>
  <section id="details" class="pane">
    <div class="toolbar details-toolbar">
      <span id="details-title" class="muted details-title"></span>
      <span class="spacer"></span>
      <button class="icon-btn" id="btn-details-collapse" title="Hide details" aria-label="Hide details"></button>
    </div>
    <div id="files" class="scroll"></div>
    <div class="hsplitter"></div>
    <div id="commit-info" class="scroll"></div>
  </section>
  </div>
  <div id="view-stash" class="view hidden">
    <section id="stash" class="pane">
      <div id="stash-list" class="scroll" tabindex="0"></div>
    </section>
    <div class="splitter" data-target="stash-files" data-side="right"></div>
    <section id="stash-files" class="pane">
      <div class="toolbar"><span id="stash-files-title" class="muted">Files</span></div>
      <div id="stash-files-tree" class="scroll" tabindex="0"></div>
    </section>
  </div>
  <div id="view-settings" class="view hidden">
    <div id="settings" class="scroll" tabindex="0"></div>
  </div>
  <div id="view-changes" class="view hidden">
    <section id="changes" class="pane">
      <div id="changes-tree" class="scroll" tabindex="0"></div>
      <div class="hsplitter" id="commit-split"></div>
      <div id="commit-box">
        <textarea id="commit-msg" placeholder="Commit message" spellcheck="true"></textarea>
        <div class="commit-actions">
          <label class="check"><input type="checkbox" id="commit-amend"> Amend</label>
          <span class="spacer"></span>
          <button class="btn" id="commit-btn">Commit</button>
          <button class="btn secondary" id="commit-push-btn">Commit and Push…</button>
        </div>
      </div>
    </section>
    <div class="splitter" data-target="changes"></div>
    <section id="change-preview" class="pane">
      <div class="preview-head"><span id="preview-title" class="preview-title"></span></div>
      <div id="preview-body" class="scroll" tabindex="0"></div>
    </section>
  </div>
</div>
<div id="menu-root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** Cambio local tal como lo manda el webview: lleva el índice de su repo. */
type Change = LocalChange & { repo: number };

