# Autorización de Streamly

## Roles

| Rol | Capacidades |
| --- | --- |
| `student` | Consulta el catálogo publicado, gestiona sus propias inscripciones y guarda su propio progreso. |
| `admin` | Incluye las capacidades de alumno. Crea, modifica y publica exclusivamente cursos cuyo `owner_id` sea su propio usuario; también administra sus lecciones. |
| `super_admin` | Tiene control global: usuarios, activación, roles, todos los cursos, propietarios, lecciones e inscripciones de cualquier alumno. |

## Reglas no negociables

- El registro público siempre crea `student`; la solicitud no puede elegir el rol.
- Solo un `super_admin` puede crear o promover a `admin`/`super_admin`.
- Un `admin` no puede modificar, publicar ni consultar datos administrativos de cursos de otro propietario.
- El super administrador puede crear un curso en nombre de un `admin` usando `ownerId` y puede inscribir un curso a cualquier `student` usando `userId`.
- Las credenciales solo se validan y almacenan como hash en el backend. JWT y secretos nunca se exponen al frontend.
- Toda ruta que reciba identificadores verifica autorización en el servidor; ocultar botones en React no es una medida de seguridad.

## Límites de acceso

- Cada curso define `access_days` (1..3650) o `NULL` (indefinido). Al crearlo sin `accessDays` se guardan 45 días.
- Al inscribirse se guarda un *snapshot* en `enrollments.expires_at` (UTC): cambiar `access_days` después solo afecta inscripciones futuras.
- Una inscripción vencida (`expires_at <= UTC_TIMESTAMP()`) responde 403 con `code: "ACCESS_EXPIRED"` en `/learn`, en el guardado de progreso y en el acceso a materiales. El cálculo se hace siempre en SQL con el reloj de MySQL.
- Quedan exentos del vencimiento el dueño del curso y el `super_admin`. Un `admin` inscrito en un curso ajeno sí está sujeto.
- Renovación: el alumno puede volver a inscribirse solo en cursos gratis; en cursos de pago recibe 409 `RENEWAL_REQUIRED`. El `super_admin` asigna (`POST /api/super/enrollments`, nunca acorta) o ajusta (`PATCH /api/super/enrollments/:id` con `extendDays` o `unlimited`).

## Constructor de cursos y constancia

- Eliminar y reordenar secciones o clases, documentos del curso e imágenes promocionales (`/api/admin/courses/:courseId/...`) exigen `admin` o `super_admin`, y además ser dueño del curso (el `super_admin` administra cualquiera). Un alumno recibe 403.
- Los documentos del curso solo se abren con URL firmada para inscritos con acceso vigente, el dueño y el `super_admin`. Un acceso vencido responde 403 `ACCESS_EXPIRED`.
- `GET /api/courses/promo` es público pero solo expone imágenes de cursos publicados.
- Constancia (`/api/courses/:courseId/certificate`): solo cursos con plantilla (`courses.certificate_template`). El alumno la obtiene con inscripción y el 100 % de las clases completadas (un acceso vencido no lo impide). Cambiar el nombre ya registrado o emitirla para otro alumno (`userId`) es exclusivo del `super_admin`. La vista previa (`preview: true`) es solo para el dueño y el `super_admin`, y no guarda registro. Límite: 6 solicitudes por minuto por usuario.

## Evaluaciones

- Crear, editar, ordenar o borrar evaluaciones y sus preguntas, y ver los resultados de los alumnos (`/api/admin/courses/:courseId/quizzes/...`), exige `admin` dueño del curso o `super_admin`. Un alumno o un `admin` ajeno reciben 403.
- El alumno solo califica en cursos donde tiene inscripción vigente (403 `ACCESS_EXPIRED` si venció) y publicados. El dueño y el `super_admin` están exentos del bloqueo por evaluaciones obligatorias; solo ellos pueden usar `preview: true`, que no guarda intentos.
- Una evaluación obligatoria sin aprobar bloquea los ítems posteriores en el servidor (403 `QUIZ_REQUIRED` en progreso y materiales de clase; `/learn` oculta `videoUrl` y materiales). Los documentos del curso nunca se bloquean.
- El servidor nunca envía `is_correct` ni `explanation` antes del envío. Después, `correctOptionIds` y `explanation` dependen de `show_answers` (`never`, `after_submit`, `after_pass`).
- Los envíos se serializan por usuario en la base de datos (`max_attempts` y una sola aprobación no se pueden saltar con peticiones simultáneas) y están limitados a 10 por minuto por usuario.
- El progreso de una evaluación no se puede marcar a mano (`PUT /api/courses/lessons/:id/progress` → 400 `QUIZ_PROGRESS_FORBIDDEN`); solo aprobarla lo registra.

## Pagos

- Un curso con `price_cents > 0` no se puede obtener con `POST /api/courses/:id/enroll`: sin inscripción previa responde 402 `PAYMENT_REQUIRED`. Dueño del curso y `super_admin` quedan exentos. Inscripciones existentes (pagadas, asignadas a mano o vencidas) mantienen su comportamiento.
- El acceso de pago solo se concede cuando el servidor confirma el pago consultando a Mercado Pago (`GET /v1/payments/{id}`) con su propio token. Ni la URL de retorno ni el cuerpo del webhook se toman como prueba.
- `POST /api/payments/verify` solo opera sobre pagos del usuario autenticado. El monto se toma siempre de la base de datos, nunca del request.
- `GET /api/super/payments` es exclusivo de `super_admin`; `GET /api/admin/payments` muestra a un `admin` solo los cursos que le pertenecen. Ninguno devuelve el `payer_email` de Mercado Pago ni datos crudos del pago; sí muestran nombre y correo de la cuenta del alumno al dueño del curso y al `super_admin`.
- No hay revocación automática por reembolso o contracargo: el pago queda marcado (`needs_review`) y el `super_admin` decide.

## Flujo inicial seguro

El esquema no inserta una cuenta administrativa ni una contraseña por defecto. Tras aplicar la migración, se crea el primer super administrador mediante el script de bootstrap del backend usando variables locales de entorno. Ese comando no se ejecuta automáticamente.
