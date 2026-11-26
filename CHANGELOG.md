# Changelog

Los cambios de cada versión de GitBrainsLog. El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [Unreleased]

### Añadido

- **El Log en una pestaña del editor o en una ventana nueva.** Dos iconos en la barra del panel Git Log, *Open in Editor Tab* y *Open in New Window*, lo sacan del panel inferior; la ventana nueva es útil con un segundo monitor. Mientras está fuera, el panel muestra un aviso con *Show Git Log* y *Move Back Here*, y cerrar la pestaña también lo devuelve al panel. **Alt+9** (**Cmd+9** en macOS) lleva al Log esté donde esté, y la pestaña se vuelve a abrir al recargar VS Code. Al moverlo conserva el borrador del commit, los anchos de los paneles, la pestaña activa y las opciones de vista, y lo que se abre desde él (diffs, archivos, *Compare*, *Show History*, el visor de conflictos) sale en el grupo de al lado para no taparlo.
- **Botón *Open File* en los diffs de revisiones.** En la barra del editor de un diff de commit, comparación o stash, un icono abre el archivo real del árbol de trabajo.

### Cambiado

- **Filtro *Paths*: selección múltiple con el menú abierto.** Un clic marca o desmarca un repositorio o una ruta sin cerrar el menú, que se cierra al pinchar fuera o con Esc; Ctrl/Cmd+clic deja marcado solo ese. Los clics seguidos se aplican de una vez, sin recargar el log en cada uno.

### Corregido

- **Borrar varios tags a la vez.** Con varios tags seleccionados en el árbol de ramas, la papelera (y la tecla Supr) salía desactivada con el aviso de que la rama actual y las protegidas no se pueden borrar, aunque no hubiera ninguna rama. Ahora se borran todos los tags con una sola confirmación (solo los locales, el remoto no se toca), también mezclados con ramas; la rama actual y las protegidas se siguen saltando.
- **`EISDIR: illegal operation on a directory, read` en Local Changes.** Los repos que tienen otro repo dentro (git lo lista como una carpeta sin seguimiento, `inner/`) daban ese error al seleccionar la carpeta, y el doble clic avisaba de que no existía. Ahora la vista previa dice que es un repo anidado (o una carpeta), el doble clic la muestra en el Explorador y los enlaces simbólicos enseñan su destino.
