import * as vscode from 'vscode';
import { FileChange, Git, HistoryEntry } from './git';
import { fontAttrs } from './fonts';
import { tabIcon } from './tabIcon';
import { nonce as newNonce } from './core';
import { FileIconsFeed } from './fileIcons';

/** Árbol vacío de git: el «padre» del commit raíz. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Show History: archivo o carpeta (ruta relativa al repo) y revisión desde la que empezar. */
export interface HistoryTarget { path: string; folder: boolean; rev?: string }

export type OpenNative = (f: FileChange, left: string, right: string | undefined) => Thenable<unknown>;

/**
 * Pestaña de comparación en el área del editor, como la de JetBrains: a la izquierda la
 * lista de archivos que cambian entre dos revisiones y a la derecha un visor lado a lado
 * de las diferencias del archivo seleccionado (media/compare.js).
 *
 * right undefined = árbol de trabajo. El doble clic (o el botón del visor) abre además el
 * diff nativo de VS Code mediante openNative.
 *
 * Con history (Show History), delante va la lista de commits que tocaron el archivo o la
 * carpeta; al elegir uno, left/right pasan a ser su padre y él, y los archivos son los de
 * ese commit (en un archivo, solo él, con la ruta que tenía entonces, y sin lista).
 */
export class ComparePanel {
  private files: FileChange[] = [];
  private seq = 0;
  private commits: HistoryEntry[] = [];
  private commitSeq = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly git: Git,
    private left: string,
    private right: string | undefined,
    private readonly title: string,
    private readonly openNative: OpenNative,
    private readonly history?: HistoryTarget,
  ) {
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    panel.onDidDispose(() => this.icons.dispose());
  }

  /** Los iconos de archivos del tema de iconos de VS Code: al arrancar la página y cuando cambian. */
  private readonly icons = new FileIconsFeed(msg => this.post(msg));

  static open(media: vscode.Uri, git: Git, left: string, right: string | undefined, title: string, openNative: OpenNative,
    column: vscode.ViewColumn) {
    ComparePanel.create(media, git, left, right, title, openNative, column);
  }

  /** Show History de un archivo o carpeta. */
  static openHistory(media: vscode.Uri, git: Git, target: HistoryTarget, title: string, openNative: OpenNative,
    column: vscode.ViewColumn) {
    ComparePanel.create(media, git, '', undefined, title, openNative, column, target);
  }

  private static create(media: vscode.Uri, git: Git, left: string, right: string | undefined, title: string,
    openNative: OpenNative, column: vscode.ViewColumn, history?: HistoryTarget) {
    const panel = vscode.window.createWebviewPanel('jbGit.compare', title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    panel.iconPath = tabIcon(media);
    const c = new ComparePanel(panel, git, left, right, title, openNative, history);
    panel.webview.html = c.html(media);
  }

  private async load() {
    if (this.history) { return this.loadHistory(); }
    try {
      this.files = (await this.git.diffNameStatus(this.left, this.right)).sort((a, b) => a.path.localeCompare(b.path));
      this.post({ type: 'init', title: this.title, left: this.left, right: this.right ?? 'Working Tree', files: this.files });
    } catch (e: any) {
      this.post({ type: 'init', title: this.title, left: this.left, right: this.right ?? 'Working Tree', files: [], error: e.message });
    }
  }

  private async loadHistory() {
    const h = this.history!;
    try {
      this.commits = await this.git.getHistory(h.path, h.folder, h.rev);
      this.post({
        type: 'history', title: this.title, path: h.path, folder: h.folder,
        commits: this.commits.map(c => ({ sha: c.sha, subject: c.subject, author: c.author, time: c.time, status: c.status, path: c.path, oldPath: c.oldPath })),
      });
    } catch (e: any) {
      this.post({ type: 'history', title: this.title, path: h.path, folder: h.folder, commits: [], error: e.message });
    }
  }

  /** Commit elegido en el historial: sus archivos (de la carpeta, o el archivo) frente a su padre. */
  private async selectCommit(index: number) {
    const c = this.commits[index];
    if (!c || !this.history) { return; }
    const seq = ++this.commitSeq;
    this.left = c.parent ?? EMPTY_TREE;
    this.right = c.sha;
    const labels = { left: c.parent ? c.parent.slice(0, 8) : 'Empty', right: c.sha.slice(0, 8) };
    try {
      this.files = this.history.folder
        ? (await this.git.diffNameStatus(this.left, this.right, [this.history.path])).sort((a, b) => a.path.localeCompare(b.path))
        : [{ status: c.status || 'M', path: c.path, oldPath: c.oldPath }];
      if (seq !== this.commitSeq) { return; }
      this.post({ type: 'init', title: this.title, ...labels, files: this.files, commit: index });
    } catch (e: any) {
      if (seq === this.commitSeq) { this.post({ type: 'init', title: this.title, ...labels, files: [], error: e.message, commit: index }); }
    }
  }

  private async onMessage(m: any) {
    switch (m?.type) {
      case 'ready':
        this.icons.sendNow();
        return this.load();
      case 'refresh':
        return this.load();
      case 'selectCommit':
        return this.selectCommit(Number(m.index));
      case 'selectFile': {
        const f = this.files[m.index];
        if (!f) { return; }
        const seq = ++this.seq;
        // Diff completo del archivo (todo el contexto) para pintarlo entero lado a lado
        const args = ['diff', '--no-color', '--no-ext-diff', '-M', '--unified=1000000', this.left];
        if (this.right) { args.push(this.right); }
        args.push('--', ...(f.oldPath ? [f.oldPath, f.path] : [f.path]));
        try {
          const text = await this.git.run(args);
          if (seq === this.seq) { this.post({ type: 'diff', index: m.index, text }); }
        } catch (e: any) {
          if (seq === this.seq) { this.post({ type: 'diff', index: m.index, error: e.message }); }
        }
        return;
      }
      case 'openNative': {
        const f = this.files[m.index];
        if (f) { await this.openNative(f, this.left, this.right); }
        return;
      }
    }
  }

  private post(msg: unknown) { this.panel.webview.postMessage(msg); }

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = newNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'compare.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'compare.js'));
    const icons = webview.asWebviewUri(vscode.Uri.joinPath(media, 'fileicons.js'));
    const dates = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dateformat.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Compare</title>
</head>
<body${fontAttrs()}>
<div id="cmp">
  <section id="cmp-commits" class="hidden">
    <div class="cmp-head">
      <span id="cmp-hist-title" class="cmp-title"></span>
      <button class="icon-btn" id="cmp-hist-refresh" title="Refresh" aria-label="Refresh"></button>
    </div>
    <input id="cmp-hist-search" type="text" placeholder="Filter commits (message, author or hash)" spellcheck="false">
    <div id="cmp-hist-list" tabindex="0" role="listbox"></div>
  </section>
  <div id="cmp-hist-split" class="cmp-split hidden"></div>
  <section id="cmp-files">
    <div class="cmp-head">
      <span id="cmp-title" class="cmp-title"></span>
      <button class="icon-btn" id="cmp-refresh" title="Refresh" aria-label="Refresh"></button>
    </div>
    <input id="cmp-search" type="text" placeholder="Filter files" spellcheck="false">
    <div id="cmp-list" tabindex="0" role="listbox"></div>
  </section>
  <div id="cmp-split" class="cmp-split"></div>
  <section id="cmp-diff">
    <div class="cmp-head">
      <span id="cmp-file" class="cmp-file"></span>
      <span class="spacer"></span>
      <span id="cmp-stats" class="muted"></span>
      <button class="icon-btn" id="cmp-prev" title="Previous Difference (Shift+F7)" aria-label="Previous Difference"></button>
      <button class="icon-btn" id="cmp-next" title="Next Difference (F7)" aria-label="Next Difference"></button>
      <button class="icon-btn" id="cmp-native" title="Open in VS Code Diff Editor" aria-label="Open in VS Code Diff Editor"></button>
    </div>
    <div class="cmp-sides-head"><span id="cmp-left-name"></span><span id="cmp-right-name"></span></div>
    <div id="cmp-body">
      <div class="cmp-side" id="cmp-left"><div class="cmp-inner"></div></div>
      <div class="cmp-side" id="cmp-right"><div class="cmp-inner"></div></div>
    </div>
  </section>
</div>
<script nonce="${nonce}" src="${icons}"></script>
<script nonce="${nonce}" src="${dates}"></script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
