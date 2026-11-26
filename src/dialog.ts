import * as vscode from 'vscode';
import { fontAttrs } from './fonts';
import { nonce as newNonce, escAttr as esc } from './core';

/**
 * Ventanas de diálogo propias (Push Commits, mensaje de Squash) como una ventana flotante de
 * VS Code, lo más parecido a los diálogos de JetBrains: un WebviewPanel que se pasa a una
 * ventana auxiliar con `workbench.action.moveEditorToNewWindow`. Si no se puede (VS Code web),
 * se queda como pestaña del editor. La página es media/dialog.js.
 *
 * Tipos: push (Push Commits) y text (mensaje de varias líneas). Las confirmaciones van en un
 * diálogo dentro del panel (la ventana flotante no deja fijar su tamaño y salía enorme).
 *
 * open() resuelve con el mensaje `result` de la página, o con undefined si se cierra la
 * ventana. Los demás mensajes (p. ej. pushPreview) van a onMessage, que puede responder con
 * post. Al moverse de ventana la página se recarga: por eso `init` se manda en cada `ready`.
 */
export class DialogWindow {
  static open(media: vscode.Uri, opts: {
    title: string;
    kind: 'push' | 'text';
    data: Record<string, unknown>;
    onMessage?: (m: any, post: (msg: unknown) => void) => unknown;
  }): Promise<any | undefined> {
    return new Promise(resolve => {
      const panel = vscode.window.createWebviewPanel('jbGit.dialog', opts.title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [media],
      });
      panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
      let done = false;
      const finish = (v: any) => {
        if (done) { return; }
        done = true;
        resolve(v);
      };
      const post = (msg: unknown) => { panel.webview.postMessage(msg); };
      panel.webview.onDidReceiveMessage(async m => {
        if (m?.type === 'ready') { post({ type: 'init', kind: opts.kind, title: opts.title, ...opts.data }); return; }
        if (m?.type === 'result') { finish(m); panel.dispose(); return; }
        try { await opts.onMessage?.(m, post); } catch (e: any) { vscode.window.showErrorMessage(e.message); }
      });
      panel.onDidDispose(() => finish(undefined));
      panel.webview.html = DialogWindow.html(panel.webview, media, opts.title);
      // A una ventana flotante (solo en el escritorio; si falla, se queda como pestaña)
      if (vscode.env.uiKind === vscode.UIKind.Desktop) {
        Promise.resolve(vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow')).catch(() => undefined);
      }
    });
  }

  private static html(webview: vscode.Webview, media: vscode.Uri, title: string): string {
    const nonce = newNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dialog.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'dialog.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>${esc(title)}</title>
</head>
<body${fontAttrs()}>
<div id="dlg"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
