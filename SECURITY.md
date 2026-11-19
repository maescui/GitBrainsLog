# Política de seguridad

## Versiones con soporte

Solo la última versión publicada recibe correcciones de seguridad.

## Cómo informar de una vulnerabilidad

**No abras un issue público.** Usa el aviso privado de GitHub:
[Report a vulnerability](https://github.com/maescui/GitBrainsLog/security/advisories/new)
(pestaña *Security* del repositorio).

Incluye, si puedes, la versión de la extensión y de VS Code, los pasos para reproducirlo y qué impacto tiene.
Intentaré responder en unos días y avisarte cuando haya una corrección.

## Qué tiene en cuenta la extensión

GitBrainsLog ejecuta `git` en tu equipo con `execFile` (nunca a través de una shell) y valida lo que llega
desde su panel antes de actuar. Si encuentras la forma de saltarse alguna de esas comprobaciones, o de
escribir fuera del repositorio abierto, es exactamente lo que interesa saber.
