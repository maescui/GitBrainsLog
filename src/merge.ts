import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import { Git } from './git';
import { fontAttrs } from './fonts';
import { tabIcon } from './tabIcon';
import { nonce as newNonce } from './core';

/**
 * Visor de conflictos de tres columnas, como el «Merge Revisions» de JetBrains: a la
 * izquierda la versión propia (ours), a la derecha la que llega (theirs) y en medio el
 * resultado, que empieza con los cambios sin conflicto ya aplicados. Cada bloque en
 * conflicto se resuelve con >> / << (aplicar ese lado) o × (descartarlo), o editando el
 * resultado. Apply escribe el archivo y lo marca como resuelto (git add).
 */

/** Trozo del archivo: igual en las tres versiones, o un bloque que cambia en algún lado. */
export type MergeSegment =
  | { kind: 'common'; lines: string[] }
  | { kind: 'ours' | 'theirs' | 'same' | 'conflict'; base: string[]; ours: string[]; theirs: string[] };

interface Hunk { side: 'o' | 't'; bs: number; bl: number; ss: number; sl: number }

/** Bloques de un `git diff -U0` (posiciones desde 0 en la versión base y en la del lado). */
export function parseHunks(diff: string, side: 'o' | 't'): Hunk[] {
  const out: Hunk[] = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const a = Number(m[1]), b = m[2] === undefined ? 1 : Number(m[2]);
    const c = Number(m[3]), d = m[4] === undefined ? 1 : Number(m[4]);
    // Con longitud 0, git da la línea anterior al punto de inserción
    out.push({ side, bs: b === 0 ? a : a - 1, bl: b, ss: d === 0 ? c : c - 1, sl: d });
  }
  return out;
}

/**
 * Mezcla a tres bandas (diff3) a partir de los cambios de cada lado respecto a la base:
 * los bloques de los dos lados que se solapan o se tocan forman un grupo; si solo cambió
 * un lado, o los dos igual, se aplica solo; si no, es un conflicto.
 */
export function diff3(base: string[], ours: string[], theirs: string[], ho: Hunk[], ht: Hunk[]): MergeSegment[] {
  const all = [...ho, ...ht].sort((x, y) => x.bs - y.bs || x.bl - y.bl);
  const segs: MergeSegment[] = [];
  let pos = 0;           // línea de la base hasta la que se ha avanzado
  let offO = 0, offT = 0; // desplazamiento acumulado de cada lado respecto a la base
  let i = 0;
  while (i < all.length) {
    let gbs = all[i].bs, gbe = all[i].bs + all[i].bl;
    const group = [all[i++]];
    while (i < all.length && all[i].bs <= gbe) {
      gbe = Math.max(gbe, all[i].bs + all[i].bl);
      group.push(all[i++]);
    }
    if (gbs > pos) { segs.push({ kind: 'common', lines: base.slice(pos, gbs) }); }
    const side = (s: 'o' | 't', lines: string[], off: number) => {
      const hs = group.filter(h => h.side === s);
      const delta = hs.reduce((n, h) => n + h.sl - h.bl, 0);
      return { changed: hs.length > 0, lines: lines.slice(gbs + off, gbe + off + delta), delta };
    };
    const o = side('o', ours, offO), t = side('t', theirs, offT);
    offO += o.delta; offT += t.delta;
    const b = base.slice(gbs, gbe);
    const kind = o.changed && t.changed
      ? (o.lines.length === t.lines.length && o.lines.every((l, k) => l === t.lines[k]) ? 'same' : 'conflict')
      : o.changed ? 'ours' : 'theirs';
    segs.push({ kind, base: b, ours: o.lines, theirs: t.lines });
    pos = gbe;
  }
  if (pos < base.length) { segs.push({ kind: 'common', lines: base.slice(pos) }); }
  return segs;
}

const open = new Map<string, MergePanel>();

export class MergePanel {
  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly git: Git,
    private readonly rel: string,
    private readonly crlf: boolean,
    private readonly onDone: () => void,
    private readonly openNative: () => Thenable<unknown>,
  ) {
    panel.webview.onDidReceiveMessage(m => this.onMessage(m));
    panel.onDidDispose(() => open.delete(this.key()));
  }

  private key() { return path.join(this.git.root, this.rel); }

  /**
   * Abre el visor para un archivo con las tres versiones del índice (:1 base, :2 ours,
   * :3 theirs). labels: nombres de cada lado (la rama de cada uno).
   */
  static async open(media: vscode.Uri, git: Git, rel: string, versions: { base: string; ours: string; theirs: string },
    labels: { ours: string; theirs: string }, onDone: () => void, openNative: () => Thenable<unknown>,
    column: vscode.ViewColumn) {
    const k = path.join(git.root, rel);
    const prev = open.get(k);
    if (prev) { prev.panel.reveal(); return; }

    const crlf = /\r\n/.test(versions.ours) || /\r\n/.test(versions.theirs);
    const norm = (s: string) => s.replace(/\r\n/g, '\n');
    const split = (s: string) => { const t = norm(s); return t === '' ? [] : t.replace(/\n$/, '').split('\n'); };
    const base = split(versions.base), ours = split(versions.ours), theirs = split(versions.theirs);
    // Salto de línea final, a tres bandas como git merge-file: si un lado no lo tocó respecto a
    // la base, manda el otro (así no se pierde que theirs lo quitara); si los dos lo cambiaron, ours
    const endsNl = (s: string) => /\n$/.test(norm(s));
    const eolBase = endsNl(versions.base), eolOurs = endsNl(versions.ours), eolTheirs = endsNl(versions.theirs);
    const eol = eolOurs === eolBase ? eolTheirs : eolOurs;

    // Cambios de cada lado respecto a la base, con git (archivos temporales)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jbgit-merge-'));
    let segs: MergeSegment[];
    try {
      const write = async (name: string, lines: string[]) => {
        const p = path.join(dir, name);
        await fs.writeFile(p, lines.length ? lines.join('\n') + '\n' : '');
        return p;
      };
      const [pb, po, pt] = await Promise.all([write('base', base), write('ours', ours), write('theirs', theirs)]);
      const [dO, dT] = await Promise.all([git.diffFiles(pb, po), git.diffFiles(pb, pt)]);
      segs = diff3(base, ours, theirs, parseHunks(dO, 'o'), parseHunks(dT, 't'));
    } finally {
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }

    const panel = vscode.window.createWebviewPanel('jbGit.merge', `Merge: ${path.basename(rel)}`, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    panel.iconPath = tabIcon(media);
    const p = new MergePanel(panel, git, rel, crlf, onDone, openNative);
    open.set(k, p);
    panel.webview.html = p.html(media);
    p.pending = { type: 'init', path: rel, ours: labels.ours, theirs: labels.theirs, segments: segs, eol };
  }

  private pending: unknown;

  private async onMessage(m: any) {
    switch (m?.type) {
      case 'ready':
        if (this.pending) { this.panel.webview.postMessage(this.pending); }
        return;
      case 'apply': {
        let text = String(m.text ?? '');
        if (this.crlf) { text = text.replace(/\r?\n/g, '\r\n'); }
        try {
          await fs.writeFile(path.join(this.git.root, this.rel), text);
          await this.git.run(['add', '--', this.rel]);
          this.panel.dispose();
          this.onDone();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Could not save the merge result: ${e.message}`);
        }
        return;
      }
      case 'confirmApply': {
        const n = Number(m.unresolved) || 0;
        const ok = await vscode.window.showWarningMessage(
          `${n} conflict${n === 1 ? ' is' : 's are'} not resolved.`,
          { modal: true, detail: 'Unresolved blocks keep the base version. Save the result and mark the file as resolved anyway?' },
          'Apply');
        if (ok === 'Apply') { this.panel.webview.postMessage({ type: 'doApply' }); }
        return;
      }
      case 'cancel':
        this.panel.dispose();
        return;
      case 'openNative':
        this.panel.dispose();
        await this.openNative();
        return;
    }
  }

  private html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = newNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'merge.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'merge.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Merge</title>
</head>
<body${fontAttrs()}>
<div id="mg">
  <div class="mg-toolbar">
    <span id="mg-file" class="mg-file"></span>
    <span id="mg-status" class="mg-status"></span>
    <span class="spacer"></span>
    <button class="btn secondary" id="mg-accept-left">Accept Left</button>
    <button class="btn secondary" id="mg-accept-right">Accept Right</button>
    <button class="icon-btn" id="mg-prev" title="Previous Conflict (Shift+F7)" aria-label="Previous Conflict"></button>
    <button class="icon-btn" id="mg-next" title="Next Conflict (F7)" aria-label="Next Conflict"></button>
  </div>
  <div class="mg-heads">
    <div id="mg-left-head"></div><div></div><div id="mg-mid-head">Result</div><div></div><div id="mg-right-head"></div>
  </div>
  <div id="mg-body" tabindex="0"></div>
  <div class="mg-footer">
    <button class="link-btn" id="mg-native">Open in VS Code Merge Editor</button>
    <span class="spacer"></span>
    <button class="btn secondary" id="mg-cancel">Cancel</button>
    <button class="btn" id="mg-apply">Apply</button>
  </div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
