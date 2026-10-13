# Artifiel Buss API

API Node.js/Express para Streamly. Usa MySQL, autenticación JWT y autorización por roles. El backend nunca expone contraseñas de base de datos ni secretos JWT al frontend.

## Roles

| Rol | Alcance |
| --- | --- |
| `student` | Catálogo, sus inscripciones y su propio progreso. |
| `admin` | Lo anterior, más crear, editar y publicar solo los cursos cuyo propietario es él. |
| `super_admin` | Gestión global de usuarios, roles, cursos, propietarios e inscripciones de cualquier alumno. |

Las reglas se aplican en el backend, no solo ocultando botones en React. Detalle completo: [`docs/authorization.md`](docs/authorization.md).

## Requisitos

- Node.js 20 o superior.
- npm.
- Acceso de red a MySQL.

## Instalación y entorno

```bash
npm install
```

Copia `.env.example` a `.env` y completa los valores locales. Como mínimo:

```dotenv
NODE_ENV=development
PORT=3000
CORS_ORIGIN=http://localhost:5173
JWT_SECRET=genera-un-secreto-largo-aleatorio-y-privado
JWT_EXPIRES_IN=8h
DB_HOST=tu-host-mysql
DB_PORT=3306
DB_USER=tu-usuario
DB_PASSWORD=tu-contrasena
DB_NAME=artifiel_buss
```

`JWT_SECRET` es obligatorio. Debe ser distinto por entorno y no se versiona.

## Comandos

```bash
npm run dev                        # Desarrollo con Nodemon
npm start                          # Ejecución normal
npm run check                      # Validación de sintaxis
npm run db:check                   # Consulta MySQL de solo lectura
npm run db:migrate                 # Bloqueado salvo APPLY_SCHEMA=true
npm run users:bootstrap-super-admin # Crea el primer super administrador
npm run test:payments              # Pruebas unitarias de pagos (sin .env ni MySQL)
npm run payments:smoke             # Lee la cuenta de Mercado Pago y crea una preferencia de prueba (sin cobro)
E2E_CONFIRM=yes npm run test:payments:e2e  # Pruebas de punta a punta con Mercado Pago FALSO contra la BD REAL (ver abajo)
```

## API

### Públicas

- `GET /api/health` y `GET /api/health/db`
- `GET /api/payments/config` — `{ enabled, currency, provider, decimals, reason? }` (siempre 200; `enabled: false` si faltan credenciales)
- `POST /api/payments/webhook` — notificaciones de Mercado Pago (tema `payment`); sin JWT. 200 `{ received: true }`, 401 firma inválida, 500 fallo transitorio (Mercado Pago reintenta)
- `GET /api/courses`
- `GET /api/courses/:slug` — incluye `sections` y `sectionId` por clase (sin URLs de video)
- `GET /c/:slug` — HTML con Open Graph para compartir un curso publicado (ver «Enlaces compartibles»)
- `GET /api/share/config` — `{ appUrl, publicApiUrl, previewAvailable }`
- `GET /api/certificates/verify/:code` y `GET /api/certificates/badge/:code.png` — verificación pública de constancias e insignia
- `POST /api/auth/register` — siempre crea `student`
- `POST /api/auth/login`

### Sesión y alumno (Bearer JWT)

- `GET /api/auth/me`
- `POST /api/courses/:courseId/enroll` — crea la inscripción con vencimiento (201), es idempotente si está vigente (200) y renueva un acceso vencido solo en cursos gratis (`renewed: true`); en cursos de pago responde 409 `RENEWAL_REQUIRED`. Un curso con `price_cents > 0` sin inscripción previa responde 402 `PAYMENT_REQUIRED` (el acceso se obtiene pagando; dueño y `super_admin` quedan exentos)
- `GET /api/payments/mine` — mis pagos (más recientes primero, máx. 100)
- `POST /api/payments/courses/:courseId/checkout` — crea la preferencia de Mercado Pago y responde 201 `{ paymentId, preferenceId, initPoint, externalReference, amount, currency }`. El monto sale siempre de la base de datos. 503 `PAYMENTS_DISABLED`, 409 `ALREADY_ENROLLED`, 422 si el curso es gratis
- `POST /api/payments/verify` — `{ externalReference, paymentId? }`; solo el dueño del pago. Consulta Mercado Pago, aplica el mismo procesador que el webhook y responde `{ payment, course, accessGranted, outcome }`
- `GET /api/courses/me/enrollments`
- `GET /api/courses/:courseId/learn` — incluye `access` (`hasLimit`, `expiresAt`, `daysRemaining`, `isExpired`, `isExpiringSoon`); un acceso vencido responde 403 `ACCESS_EXPIRED`
- `GET /api/account/overview` — inscripciones con campos de acceso y métricas `activeCourses`, `expiringSoonCourses`, `expiredCourses`
- `PUT /api/courses/lessons/:lessonId/progress`

### Admin y super admin (Bearer JWT)

- `GET|POST /api/admin/courses` — al crear, `accessDays` ausente = 45 días, `null` = acceso indefinido
- `PATCH /api/admin/courses/:courseId` — acepta `accessDays` (entero 1..3650, o `null` para acceso indefinido)
- `GET /api/admin/courses/:courseId/students` y `GET /api/admin/courses/:courseId/students/:userId/progress` (desglose por clase)
- `POST /api/admin/courses/:courseId/lessons`
- `POST /api/admin/courses/:courseId/publish`

- `GET /api/admin/payments?status=&page=&pageSize=` — pagos de los cursos propios (el `super_admin` ve todos). `status`: `pending|approved|in_process|rejected|cancelled|refunded|charged_back|review`; `pageSize` 1..50 (20 por defecto). Devuelve `payments`, `page`, `pageSize`, `total`, `totals` (por estado) y `currency`. Incluye nombre y correo de la cuenta del alumno, pero nunca el `payer_email` de Mercado Pago ni datos crudos

`admin` solo puede operar cursos de su propiedad. `super_admin` puede operar todo y además usa:

- `GET|POST|PATCH /api/super/users`
- `POST /api/super/courses/:courseId/owner`
- `POST /api/super/enrollments` — asigna o renueva (nunca acorta un vencimiento existente)
- `PATCH /api/super/enrollments/:enrollmentId` — `{ "extendDays": N }` o `{ "unlimited": true }`

- `GET /api/super/payments` — mismo formato que el listado de admin, para todos los cursos

### Pagos con Mercado Pago (Checkout Pro)

La integración usa la API REST de Mercado Pago con `fetch` (sin SDK ni dependencias nuevas) y la Preferences API clásica con el tema de webhook `payment`. La migración [`database/007_payments.sql`](database/007_payments.sql) solo agrega la tabla `payments`.

Variables de entorno (todas opcionales; sin ellas los pagos quedan deshabilitados y el resto de la API funciona igual):

- `MERCADOPAGO_ACCESS_TOKEN` y `MERCADOPAGO_PUBLIC_KEY`: credenciales de la aplicación. `MERCADOPAGO_CLIENT_ID` y `MERCADOPAGO_CLIENT_SECRET` se guardan en `.env` pero esta integración no las usa.
- `MERCADOPAGO_WEBHOOK_SECRET`: clave secreta de firma que Mercado Pago muestra en *Tus integraciones > Webhooks*. Si existe, la firma `x-signature` es obligatoria.
- `PUBLIC_API_URL`: URL pública https del backend; habilita `notification_url` (`${PUBLIC_API_URL}/api/payments/webhook`).
- `APP_URL`: URL del frontend para las `back_urls` (`/pago/resultado`). Por defecto usa `FRONTEND_URL`, el primer `CORS_ORIGIN` que no sea `*`, o `http://localhost:5173`.
- `TRUST_PROXY`: saltos de proxy (`1`, normalmente) o `loopback|linklocal|uniquelocal`. Vacío = desactivado. Detrás de Render, Railway, Nginx o Cloudflare **hay que fijarlo**: si no, `request.ip` es la IP del proxy y el límite de peticiones del webhook agrupa a todos. No se acepta `true`.
- `MERCADOPAGO_API_BASE_URL`: solo para pruebas locales con un Mercado Pago falso. Se **ignora con `NODE_ENV=production`** (el arranque lo avisa sin mostrar valores).

Modelo de dinero: `courses.price_cents` se interpreta como centésimas de la moneda de la cuenta. La moneda sale de `site_id` (`GET /users/me`: MLA→ARS, MLB→BRL, MLC→CLP, MLM→MXN, MCO→COP, MPE→PEN, MLU→UYU) y no hay conversión. CLP y COP no usan decimales (4999 → 50). La misma regla se usa al mostrar precios.

Configuración del webhook: en el panel de Mercado Pago registra `${PUBLIC_API_URL}/api/payments/webhook`, activa el tema *Pagos* y copia la clave secreta en `MERCADOPAGO_WEBHOOK_SECRET`. En local (`localhost`) el webhook no puede llegar al servidor y `auto_return` no se envía: usa el botón de verificación (`POST /api/payments/verify`).

Idempotencia: cada intento de pago tiene un `external_reference` UUID único; toda actualización ocurre en una transacción que bloquea la fila (`SELECT ... FOR UPDATE`), así webhook y verify no duplican el acceso. Un pago aprobado crea la inscripción o renueva una vencida (nunca acorta). Monto, moneda o metadatos distintos, pagos duplicados, reembolsos y contracargos marcan `needs_review` para el super administrador. **No hay revocación automática de acceso tras un reembolso.** Las referencias `demo-` nunca otorgan acceso.

Orden del checkout: primero se inserta el registro `pending` (sin preferencia) y después se crea la preferencia en Mercado Pago. Si Mercado Pago falla, el registro queda `cancelled` (`status_detail = checkout_failed`) y el usuario puede reintentar; nunca queda una preferencia sin registro. Los administradores del curso (super admin o dueño) reciben `409 COURSE_MANAGER`; un alumno con acceso vigente, `409 ALREADY_ENROLLED`.

Meses sin intereses (MSI) y cuotas: la preferencia **no restringe** medios de pago ni cuotas. Checkout Pro muestra las cuotas/MSI que tenga habilitadas tu cuenta de Mercado Pago y el banco emisor de la tarjeta (en México suelen tener un monto mínimo). Para ofrecer MSI se configura en tu cuenta de Mercado Pago, no en este código. `payment_methods.installments` solo sirve para *limitar* el máximo de cuotas, por eso no se envía.

#### Checklist de producción (pagos)

1. Backend (`back-stream/.env` en el hosting): `NODE_ENV=production`, `MERCADOPAGO_ACCESS_TOKEN` (credenciales de **producción**, prefijo `APP_USR-`), `MERCADOPAGO_PUBLIC_KEY`, `MERCADOPAGO_WEBHOOK_SECRET`, `PUBLIC_API_URL=https://api.tudominio.com`, `APP_URL=https://tudominio.com`, `CORS_ORIGIN=https://tudominio.com`, `TRUST_PROXY=1` (o los saltos reales), y las variables de MySQL, JWT y Cloudinary de siempre. No definas `MERCADOPAGO_API_BASE_URL`.
2. Frontend (en el build de Vite): `VITE_API_URL=https://api.tudominio.com`. Es una variable de compilación: hay que volver a construir y publicar.
3. Registrar el webhook en Mercado Pago: *Tus integraciones* > tu aplicación > *Webhooks* > modo **Producción** > URL `${PUBLIC_API_URL}/api/payments/webhook` > evento **Pagos** (`payment`) > guardar. Usa el botón *Simular notificación* del panel: debe responder 200.
4. Secreto de firma: en esa misma pantalla de Webhooks, tras guardar, aparece la *clave secreta*. Cópiala en `MERCADOPAGO_WEBHOOK_SECRET` y reinicia el backend. Con el secreto definido la firma `x-signature` es obligatoria (sin él, el webhook aceptaría llamadas sin firma).
5. Reiniciar el backend y revisar el arranque: no debe imprimir líneas `[config] Producción: ...`. Si aparecen, falta alguna de las variables de arriba.
6. Primera prueba real: crea un curso de **10 MXN**, cómpralo con una tarjeta real desde una cuenta de alumno, confirma que vuelves a `/pago/resultado` con «Pago aprobado», que el curso queda activo y que el pago aparece en `/api/super/payments`. Después reembólsalo desde el panel de Mercado Pago: el pago pasa a `refunded` y queda marcado para revisión, pero el acceso **no** se revoca solo (se quita desde la gestión de inscripciones).
7. Un comprador no puede pagarse a sí mismo con la cuenta vendedora (Mercado Pago lo rechaza): usa otra cuenta/tarjeta para la prueba.

Pruebas de punta a punta (`npm run test:payments:e2e`): levantan un Mercado Pago **falso** (puerto 3199) y un backend temporal (puerto 3100) y ejecutan los escenarios con HTTP real contra la **base de datos real**. Crean usuarios y cursos temporales con prefijo `e2e-` y los borran al terminar. Por tocar la BD real solo corren con confirmación explícita: `E2E_CONFIRM=yes npm run test:payments:e2e` (en PowerShell: `$env:E2E_CONFIRM='yes'; npm run test:payments:e2e`). No forman parte de `npm run check`. No cobran ni usan tus credenciales de Mercado Pago. No pueden probar el webhook real de Mercado Pago ni una tarjeta real.

### Enlaces compartibles y verificación de constancias

Variables del backend (en producción deben ser `https`):

```env
APP_URL=https://tudominio.com          # frontend: destino de /c/:slug, back_urls de pago y URL de verificación de constancias
PUBLIC_API_URL=https://api.tudominio.com  # este backend: webhook de pagos y enlace /c/:slug que se comparte
```

- `GET /c/:slug` devuelve un HTML mínimo con las etiquetas Open Graph y Twitter (título, descripción de hasta 200 caracteres, portada) y redirige con `<meta http-equiv="refresh">` a `${APP_URL}/curso/<slug>`, con un enlace «Ir al curso» visible como respaldo. Existe porque WhatsApp, Facebook y LinkedIn no ejecutan JavaScript y no verían la vista previa de la SPA. Solo responde para cursos **publicados**; un slug inválido, inexistente o en borrador devuelve el mismo 404 genérico. Todo valor interpolado va escapado y la página no contiene `<script>`. Límite: 120 peticiones por minuto por IP.
- `GET /api/share/config` indica `{ appUrl, publicApiUrl, previewAvailable }`. `previewAvailable` es `false` si `PUBLIC_API_URL` falta o apunta a localhost; el frontend lo usa para avisar que el enlace con vista previa solo funciona con el sitio publicado.
- `GET /api/certificates/verify/:code` devuelve los datos públicos de una constancia (nombre, curso, emisor, fecha, horas, modalidad, ID, instructor) o un 404 genérico; `GET /api/certificates/badge/:code.png` entrega la insignia. Ambas son públicas y limitadas por IP.
- Variables opcionales del **frontend** (`front-stream/.env.example`): `VITE_PUBLIC_APP_URL` (origen público del sitio para el enlace directo; por defecto el origen actual) y `VITE_LINKEDIN_ORGANIZATION_ID` (ID de la página de empresa de LinkedIn para «Añadir a LinkedIn»).

### Evaluaciones

Una evaluación es una fila de `lessons` con `kind = 'quiz'` más su configuración en `quizzes` (`quizId` es siempre igual a `lessonId`). Comparte sección y posición con los videos, así que se ordena, se mueve entre secciones (`PUT /api/admin/courses/:courseId/lessons/order`) y se borra junto con su sección. Las clases con `kind = 'video'` siguen numerándose «Clase 1..N»; la evaluación tiene `lessonNumber: null`.

Docente (`/api/admin`, `admin` dueño del curso o `super_admin`):

- `POST /courses/:courseId/quizzes` `{ sectionId, index?, title, description?, label?, passingPercent?, isRequired?, maxAttempts?, showAnswers? }` → 201 `{ quiz }`. La inserta en la posición `index` de la sección.
- `GET|PATCH|DELETE /courses/:courseId/quizzes/:quizId` (el `GET` incluye preguntas con `isCorrect` y `attemptCount`; `DELETE` responde `{ deleted: { questions, attempts } }`).
- `POST /courses/:courseId/quizzes/:quizId/questions`, `PUT .../questions/order` `{ questionIds }`, `PUT|DELETE .../questions/:questionId`.
- `GET /courses/:courseId/quizzes/:quizId/results?page=&pageSize=` (1..50) con resumen y intentos.

Alumno (`/api/courses`, inscripción vigente, dueño o `super_admin`):

- `GET /:courseId/quizzes/:quizId`: preguntas y opciones **sin** `isCorrect` ni `explanation`.
- `POST /:courseId/quizzes/:quizId/attempts` `{ answers: { [questionId]: [optionId] }, preview? }`: máximo 10 envíos por minuto por usuario (429). `preview: true` solo para el dueño o el `super_admin` y no guarda nada.
- `GET /:courseId/quizzes/:quizId/attempts/mine`.

Reglas:

- Una evaluación es **obligatoria efectiva** si `is_required = 1` y tiene al menos una pregunta. Las vacías son invisibles para el alumno, no bloquean y no cuentan.
- Bloqueo: la primera evaluación obligatoria no aprobada bloquea todo lo posterior del curso (videos, materiales de clase y otras evaluaciones). `GET /learn` marca esos ítems con `locked`, `lockedBy`, `videoUrl: null` y `materials: []`; el guardado de progreso y los materiales de clase responden 403 `QUIZ_REQUIRED`. Los documentos del curso nunca se bloquean. El dueño y el `super_admin` están exentos. Los cambios de obligatoriedad, orden o borrado aplican en la siguiente petición.
- Calificación: `single` y `true_false` aciertan con la opción correcta; `multiple` exige el conjunto exacto (sin crédito parcial). Se aprueba si `puntos * 100 >= passingPercent * total` con enteros. Aprobar escribe `lesson_progress.completed_at` en la misma transacción.
- `show_answers`: `never` (solo `isCorrect` por pregunta), `after_submit` (respuestas correctas y explicación tras cada envío) o `after_pass` (solo si aprobó). Antes del envío el servidor nunca manda las respuestas correctas.
- Avance y constancia: cuentan los videos y las evaluaciones obligatorias efectivas. Las opcionales no bloquean ni cuentan. `GET /:courseId/certificate` añade `pendingRequiredQuizzes: [{ id, title }]`.
- `PUT /api/courses/lessons/:id/progress` sobre una evaluación responde 400 `QUIZ_PROGRESS_FORBIDDEN`.
- Publicar un curso con una evaluación sin preguntas responde 409 `QUIZ_INCOMPLETE`.

Códigos: `QUIZ_REQUIRED` (403), `ATTEMPTS_EXHAUSTED` (403), `QUIZ_ALREADY_PASSED` (409), `QUIZ_INCOMPLETE` (409), `QUIZ_PROGRESS_FORBIDDEN` (400).

Migraciones aplicadas por `npm run db:migrate`: `001_initial_schema`, `002_categories`, `003_course_sections`, `004_course_materials`, `005_lesson_materials`, `006_access_limits`, `007_payments`, `008_builder_promo_certificates`, `009_instructor_display` y `010_quizzes` (tablas `quizzes`, `quiz_questions`, `quiz_options`, `quiz_attempts` y la columna `lessons.kind`).

Pruebas de API (`E2E_CONFIRM=yes npm run test:quizzes:e2e`): backend temporal en el puerto 3100 contra la base real, con datos `e2e-quiz-` que se borran al terminar.

### Política de acceso de los cursos

`courses.access_days` define cuántos días de acceso recibe cada inscripción nueva (`NULL` = indefinido). La migración [`database/006_access_limits.sql`](database/006_access_limits.sql) añade `courses.access_days` y `enrollments.expires_at` (UTC, `NULL` = sin vencimiento).

### Datos demo con estados de acceso

`SEED_DEMO_DATA=true npm run seed:demo` crea (o re-ancla) cuentas y cursos de demostración. Requiere la migración 006 y es idempotente: no duplica usuarios, cursos, clases ni inscripciones.

- Cuentas: `instructor.demo@streamly.test` (`DemoInstructor2026!`) y los alumnos `alumna.demo`, `mateo.demo`, `valentina.demo`, `diego.demo` y `camila.demo` `@streamly.test` (`DemoStudent2026!`).
- Alumna demo (`alumna.demo@streamly.test`): `notion-productividad-demo` indefinida y activa, `diseno-interfaces-demo` por vencer (+5 días) y **`fotografia-movil-demo` expirada (−3 días)**. Ese es el único curso con acceso expirado de la alumna demo.
- Otros estados en `notion-productividad-demo`: Mateo por vencer, Valentina completado, Diego expirado y Camila inactiva. Juan (super admin) conserva `expires_at NULL` en todas sus inscripciones.
- Los vencimientos del seed son relativos al momento de ejecutarlo. Vuelve a ejecutar el comando para re-anclar las fechas a hoy (por ejemplo, para volver a dejar la fotografía expirada −3 días o renovar los que ya vencieron).

## Migración de esquema — requiere confirmación

La migración [`database/001_initial_schema.sql`](database/001_initial_schema.sql) crea estas tablas nuevas: `users`, `courses`, `lessons`, `enrollments` y `lesson_progress`. Incluye relaciones, índices y no elimina ni modifica tablas existentes.

Antes de aplicarla:

1. Revisa el archivo SQL y toma un respaldo de `artifiel_buss`.
2. Confirma explícitamente que se pueden crear esas cinco tablas en la base remota.
3. Ejecuta desde `back-stream/`:

```bash
APPLY_SCHEMA=true npm run db:migrate
```

Después crea el primer super administrador. Este comando inserta un usuario con contraseña hasheada, por lo que también debe ejecutarse solo con autorización explícita:

```bash
BOOTSTRAP_SUPER_ADMIN_NAME="Nombre" \
BOOTSTRAP_SUPER_ADMIN_EMAIL="admin@example.com" \
BOOTSTRAP_SUPER_ADMIN_PASSWORD="una-contrasena-de-10-o-mas-caracteres" \
npm run users:bootstrap-super-admin
```

## Seguridad

- `.env` es local e ignorado por Git.
- Contraseñas: hash `bcryptjs` con coste 12; nunca se guardan ni devuelven en texto plano.
- Sesión: JWT firmado con `JWT_SECRET`; las rutas protegidas vuelven a leer el usuario activo desde MySQL.
- SQL: consultas parametrizadas y consultas múltiples desactivadas.
- Cloudinary: las credenciales privadas pertenecen al backend; nunca se colocan en variables `VITE_*` del frontend.
- En producción, usa HTTPS, restringe `CORS_ORIGIN`, configura TLS a MySQL si está disponible y rota las credenciales compartidas fuera de un canal seguro.
