import * as vscode from 'vscode';

/**
 * Icono de la pestaña de un webview de la extensión. VS Code lo pinta como imagen, así que el
 * currentColor de media/icon.svg no toma el color del tema: una variante para temas claros y
 * otra para oscuros, con el color de icono por defecto de VS Code.
 */
export function tabIcon(media: vscode.Uri): { light: vscode.Uri; dark: vscode.Uri } {
  return { light: vscode.Uri.joinPath(media, 'icon-light.svg'), dark: vscode.Uri.joinPath(media, 'icon-dark.svg') };
}
