# Mensajes entre el webview y la extensión

Los mensajes son objetos `{ type, … }`. Esta lista debe coincidir con lo que maneja el código: un test (`tipos de mensaje` en `src/test/webview.test.ts`) la compara con los `case` de `onMessage` (extension.ts) y del listener de `media/main.js`, y falla si falta o sobra alguno. Al añadir o quitar un mensaje hay que actualizarla.

## Hacia la extensión (35)

- `ready`
- `refresh`
- `filter`
- `logFilter`
- `logOption`
- `pickLogFilter`
- `loadMore`
- `selectCommit`
- `openFileDiff`
- `openFile`
- `commitAction`
- `commitsAction`
- `showHistory`
- `branchAction`
- `tagAction`
- `repoAction`
- `branchesAction`
- `toggleFavorite`
- `openChange`
- `previewChange`
- `rollbackBlock`
- `stageBlock`
- `ignore`
- `changeAction`
- `commit`
- `selectStash`
- `openStashDiff`
- `stashAction`
- `setSetting`
- `openSettings`
- `opAction`
- `pickMerge`
- `confirmResult`
- `dialogResult`
- `uiState`

## Hacia el webview (12)

- `data`
- `confirm`
- `mergeDialog`
- `settings`
- `details`
- `changes`
- `changePreview`
- `committed`
- `stashes`
- `stashFiles`
- `noRepo`
- `error`
