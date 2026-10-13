# NocoDB Whitelabel — fork y despliegue

Estado al 2026-10-13. Este documento es el punto de partida de cualquier sesión de trabajo en este fork.

## Qué es este repo

- Fork de `nocodb/nocodb` en `github.com/whitelabel-lat/nocodb`.
- Remotos: `origin` = el fork, `upstream` = `nocodb/nocodb`.
- Rama de despliegue: `main` (rama por defecto del fork).
- `main` = `upstream/develop` (commit `58adddcea3`, 2026-10-12) + nuestros commits.
- Es la edición **comunitaria (CE)**. La imagen oficial `nocodb/nocodb` es EE/on-prem, construida desde un repo privado (`nocodb/nocohub`). El backend EE no está en el repo público.
- Licencia: Sustainable Use License. Uso interno y obras derivadas permitidas; no distribuir ni vender.
- **Regla clean-room**: todo lo EE que construyamos se escribe desde el esquema público (migraciones), los tipos del SDK (`packages/nocodb-sdk`), el código CE y los prototipos públicos (`packages/nc-gui/pages/playground`). Nunca copiar ni descompilar el bundle de la imagen oficial.

## Producción

| Dato | Valor |
|---|---|
| URL | https://nocodb.whitelabel.lat |
| Servidor | `ssh proyectos` (72.62.167.241), Dokploy |
| Dokploy | org `whitelabel` → proyecto `Nocodb` → env `production` |
| Servicio | application `nocodb-app-zd2t78` (GitHub `whitelabel-lat/nocodb`, rama `main`, `./Dockerfile`) |
| Auto-deploy | Sí: cada push a `main` construye y despliega (~10 min en el servidor) |
| Base de datos | servicio postgres `nocodb-db-0wxodv`, base `noco_db` |
| Adjuntos | volumen `nocodb-nocodb-j1bcgn_nc_data` → `/usr/app/data` |
| Traefik | `/etc/dokploy/traefik/dynamic/nocodb-app-zd2t78.yml` escrito a mano (Dokploy no lo generó al mover el dominio por SQL). Si se edita el dominio en la UI, Dokploy lo regenera. |
| Servicio viejo | compose `nocodb-nocodb-j1bcgn` (imagen oficial) **apagado**, `restart=no`, se conserva para rollback. Borrarlo cuando todo esté confirmado. |
| SMTP | Gmail, plugin `smtp` en `nc_plugins_v2`. UI: Admin Panel → Setup → Email, o Cuenta → Setup. |

**Push a `main` = despliegue a producción.** No hacer push sin probar antes (ver "Probar antes de subir").

## Respaldos (en el servidor, `/root/backups/nocodb/`)

| Archivo | Momento |
|---|---|
| `noco_db-20261013-1726.dump` + `nc_data-20261013-1726.tgz` | antes de todo (imagen oficial 2026.09.0) |
| `noco_db-20261013-1857-precambio.dump` | antes del cambio a CE |
| `noco_db-20261013-2052-predevelop.dump` | antes de subir a develop |
| `noco_db-*-pre-f1.dump` | antes de la función "quitar miembro" |

Respaldo nuevo antes de cada push con migraciones:

```bash
ssh proyectos 'TS=$(date +%Y%m%d-%H%M); D=$(docker ps --format "{{.Names}}" | grep nocodb-db-0wxodv); docker exec $D pg_dump -U postgres -d noco_db -Fc -Z6 > /root/backups/nocodb/noco_db-$TS.dump; docker exec -i $D pg_restore -l < /root/backups/nocodb/noco_db-$TS.dump | grep -c "TABLE DATA"'
```

## Rollback

1. Revertir el commit en `main` y hacer push (redepliega el código anterior). Si hubo migraciones, además restaurar el dump previo.
2. Emergencia, volver a la imagen oficial: parar el servicio `nocodb-app-zd2t78`, mover la fila de `domain` (`nocodb.whitelabel.lat`) de vuelta al compose (`domainType='compose'`, `serviceName='nocodb'`), restaurar `noco_db-20261013-1857-precambio.dump` y `docker start nocodb-nocodb-j1bcgn-nocodb-1`. La imagen oficial no entiende las migraciones nuevas: el restore es obligatorio.

## Nuestros cambios sobre upstream

- `Dockerfile`, `.dockerignore`, `packages/nocodb/docker/rspack.config.js`: build desde el código (upstream ya no publica Dockerfile). `ARG NC_VERSION` fija la versión mostrada; el `package.json` del repo trae un placeholder.
- `packages/nc-gui/utils/ceUiFeatures.ts`: activa pantallas EE una por una (`isEeUI || ceUiFeatures.x`). **No** cambiar `isEeUI` a `true`: mostraría pantallas sin backend.
  - `adminPanel`, `extensions`, `hideJoinCloud`, `workspaceMemberRemove`, `audit`.
- Admin Panel → Setup → Email (SMTP) y entrada "Setup" en la cuenta; banner "Gifts Unlocked" quitado.
- `store/sidebar.ts`: constante local `BASE_OVERVIEW_ROUTE` (bug de upstream develop: la usa sin definirla).
- **Función: quitar miembro del workspace** (`DELETE /api/v1/workspaces/:ws/users/:user`). Quita roles de base del workspace y tokens limitados a esas bases; limpia cachés de nuevo después del commit (ver trampas). `WorkspaceUser.insert` reactiva una fila borrada (re-invitar fallaba por PK duplicada).
- **Función: auditoría** (operaciones internas `instanceAuditList` super admin, `workspaceAuditList` owner, `baseAuditList` owner/creator). Pantallas en Admin Panel, ajustes de workspace y de base. Migración `nc_202610131700_audit_created_at_idx` con `CREATE INDEX CONCURRENTLY` (no bloquea escrituras; ~4 s sobre 418 k filas). Redacción de secretos en `utils/auditRedaction.ts`.

Archivos marcados `// CE implementation (whitelabel fork)` son stubs de upstream que reemplazamos: en cada merge de upstream revisar que sigan siendo nuestros.

## Actualizar desde upstream

```bash
git fetch upstream develop
git merge upstream/develop          # merge commit, nunca rebase de main (ya está publicado)
```

1. Resolver conflictos conservando `ceUiFeatures` y los stubs implementados por nosotros.
2. Revisar migraciones nuevas: `git diff --name-status <base> upstream/develop -- packages/nocodb/src/meta/migrations`. Son irreversibles en producción.
3. Subir `NC_VERSION` en el `Dockerfile` (formato actual `2026.09.1-beta.<n>.g<sha>`; el GUI no muestra "upgrade" si contiene `-beta.`).
4. Probar (abajo), respaldo, push.

`develop` trae bugs (ej. `BASE_OVERVIEW_ROUTE`); los tags publicados son más estables pero a veces vienen incompletos (el tag `2026.09.1` no traía 3 migraciones que su propio código importa).

## Probar antes de subir

1. `docker build -t nc-ce:test .` (~4-5 min en local; pico de RAM ~5 GB; en el servidor bajó a ~5 GB libres de 8,6).
2. Dump fresco de producción a local (datos reales: nunca subirlos ni commitearlos):
   `ssh proyectos '... pg_dump -Fc ...' > /tmp/nocodb-cmp/noco_db.dump`
3. `postgres:16` local + `pg_restore --no-owner`. **Antes de arrancar NocoDB**, en la copia: `UPDATE nc_plugins_v2 SET active=false WHERE category='Email';` (si no, envía correos reales) y desactivar webhooks.
4. Arrancar la imagen con `NC_DB` a la copia y revisar: migraciones sin error, conteos (bases, usuarios, modelos, columnas, vistas, base_users, api_tokens, filas de tablas grandes), acceso por usuario, y las pantallas tocadas con Playwright.
5. Contraseña de pruebas siempre por variable de entorno, nunca en archivos.

Tests de backend: el `testRegex` de jest del repo solo toma `(Integration|Source).spec.ts`. Nuestros specs se corren así:

```bash
cd packages/nocodb
npx jest --testRegex 'workspace-users.service.spec.ts$'
AUDIT_TEST_PG=postgres://user:pw@host:port/db npx jest --testRegex 'audits-list.spec.ts$' --runInBand --forceExit   # Postgres desechable
```

## Hoja de ruta pendiente

Clasificación del análisis de huecos EE (el GUI EE tampoco está: ~250 archivos "CE stub"; sí están las tablas y los tipos del SDK).

| # | Función | Esfuerzo | Notas |
|---|---|---|---|
| 3 | Bookmarks / favoritos | 3-4 d | `nc_bookmarks`, SDK `bookmark.ts` |
| 4 | Plantillas de registros | 3-4 d | `nc_record_templates`, SDK `recordTemplate.ts` |
| 5 | White label | 3-5 d | `useBranding*`, config en `nc_store`. Mantener las vistas previas del login (decisión del usuario). |
| 6 | Papelera de bases y tablas | 6-8 d | `nc_trash`, job `BaseTrashCleanUp` |
| 7 | Snapshots (respaldo/restauración de una base) | 6-9 d (+2 programados) | jobs `CreateSnapshot`/`RestoreSnapshot`, `duplicate.processor` |
| — | Color de filas | 12-16 d | Backend parcial (`view-row-color.controller.ts`, modelo sin `update`, servicio stub), el lado de pintar ya existe; falta servicio, ACL, evaluación y UI. Prototipo en `pages/playground/components/row-color-picker-toolbar`. Pedido por el usuario, para después. |
| — | Filtros dinámicos en Links/Lookups | 3-5 d | Código en `linkedRecordDynamicFilter.ts`, falta aplicarlo en el picker |
| — | 2FA | 4-5 d | El usuario pidió no hacerlo por ahora |
| — | Permisos por tabla/campo | 10-15 d | Delicado en seguridad |
| — | Teams, SSO, SCIM, Skills, IA, Sync | 6-35 d c/u | Solo si hace falta |
| — | Workflows, Docs, Interfaces, Dashboards, Scripts, multi-workspace | 15-70 d c/u | No vale la pena (hay n8n; un solo workspace) |

No activables con flag (pantalla CE vacía): página nueva de API tokens (backend solo list/create/delete), undo/redo (`useUndoRedo` stub), "New Connection" de MCP en la cuenta, vista Map (`smartsheet/Map.vue` vacío), páginas de cuenta Security/External Integrations.

## Trampas conocidas

- **Caché dentro de transacciones**: si se borra NocoCache dentro de una transacción, una petición concurrente puede rellenarla con datos previos al commit. Producción no tiene Redis (caché en memoria). Invalidar otra vez **después** del commit.
- `ApiToken.list` no devuelve el valor del token (solo `token_prefix`); la caché de autenticación se indexa por el valor.
- Iniciar sesión por API (`/api/v1/auth/user/signin`) cierra la sesión del navegador del mismo usuario.
- Webhook de Dokploy para apps GitHub: exige header `X-GitHub-Event: push` y `ref: refs/heads/main`. Dokploy llegó a guardar la rama como `develop`; verificar `branch='main'` en la tabla `application`.
- `nc-gui/lib/acl.ts` lanza error (pantalla en blanco) si un permiso aparece en dos roles que se heredan.
- Las fuentes externas (Aurora_prod, aurora_dev, HI DEV) cifran sus credenciales con secretos de producción: en una copia local no cargan filas.
