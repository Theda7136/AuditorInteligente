# Auditor Inteligente

Aplicación web para revisar riesgos contractuales y preparar negociaciones. El análisis puede ejecutarse con reglas locales o con Gemini. No sustituye el criterio de un abogado.

## Requisitos

- Node.js **22.5 o superior** (se utiliza el módulo SQLite integrado `node:sqlite`).
- Una clave de Google AI Studio es opcional; sin ella funciona el motor local.

## Ejecutar en VS Code

Abre la carpeta del proyecto en VS Code y, desde la terminal integrada, ejecuta:

```powershell
Copy-Item .env.example .env
```

En macOS/Linux puedes usar `cp .env.example .env`.

Edita `.env`:

```env
GEMINI_API_KEY=tu_clave_de_google_ai_studio
PORT=8765
NODE_ENV=development
TRUSTED_PROXY_IPS=
```

`TRUSTED_PROXY_IPS` se deja vacío por defecto. Si usas un proxy inverso, configura ahí las IP/subredes CIDR de los proxies que controlas; no agregues rangos amplios de red sin confirmar que solo tus proxies pueden conectarse desde ellos.

La clave es opcional para el análisis local. No compartas `.env` ni lo subas a GitHub. Después inicia el servidor:

```bash
npm start
```

Abre [http://localhost:8765](http://localhost:8765).

La primera ejecución crea automáticamente `data/auditor-inteligente.sqlite`. Esa carpeta y sus archivos están excluidos de Git. No borres la base de datos si quieres conservar cuentas e historial.

## Cuentas e historial

Puedes seguir usando la aplicación como invitado. En ese modo el historial se conserva en el navegador. Al crear una cuenta o iniciar sesión:

- La contraseña se deriva con `scrypt` y una sal aleatoria; no se almacena en texto plano.
- La sesión utiliza un token aleatorio cuyo hash se guarda en SQLite.
- La cookie de sesión es `HttpOnly` y `SameSite=Strict`; en `NODE_ENV=production` también lleva `Secure`.
- Las operaciones que modifican datos requieren un token CSRF y validación de origen cuando el navegador envía `Origin`.
- El historial se filtra por el usuario autenticado. Cada cuenta solo puede consultar y borrar sus propios análisis.
- El servidor guarda el dictamen y un extracto breve, no el documento completo. El dictamen puede contener citas extraídas del contrato.

Las contraseñas deben tener entre 10 y 128 caracteres. La sesión dura hasta siete días, salvo cierre de sesión o expiración. No hay recuperación de contraseña ni verificación de correo en esta versión.

## API principal

- `GET /api/health`: estado del servidor y disponibilidad de Gemini.
- `GET /api/auth/csrf`: obtiene el token CSRF inicial.
- `POST /api/auth/register`: crea una cuenta.
- `POST /api/auth/login`: inicia sesión.
- `POST /api/auth/logout`: cierra la sesión.
- `GET /api/auth/me`: consulta el usuario de la sesión.
- `GET /api/history`: lista el historial del usuario autenticado.
- `POST /api/history`: guarda un dictamen sin el documento completo.
- `DELETE /api/history/:id`: elimina un análisis propio.
- `DELETE /api/history`: elimina todo el historial propio.
- `POST /api/analyze`: solicita análisis a Gemini.

Las rutas de autenticación y de historial requieren protección CSRF en las operaciones de escritura. La API de análisis continúa disponible para el modo invitado y aplica estas cuotas por ventana de una hora: 3 análisis por IP invitada, 12 por cuenta y 20 por IP en total. El endpoint acepta únicamente JSON y rechaza solicitudes de origen cruzado. El servidor valida el texto, el modelo y las opciones antes de invocar Gemini; limita la entrada analizada a 350 000 caracteres y la salida del modelo a 4096 tokens. La clave Gemini permanece en el servidor. Las cuotas se guardan en SQLite y sobreviven reinicios en una instalación de un solo servidor.

## Pruebas

```bash
npm test
```

Las pruebas cubren el motor de reglas, la API, el registro, el inicio/cierre de sesión, CSRF, cookies y aislamiento del historial entre cuentas. No necesitan una clave Gemini ni conexión externa.

## Privacidad y límites de esta versión

El documento solo se envía a Gemini después de que el usuario acepte el envío en la interfaz. Google procesa ese contenido bajo sus propias condiciones. En modo cuenta, el servidor guarda el resultado del análisis y un extracto corto; las citas del dictamen pueden contener fragmentos del documento. El texto completo no se guarda en SQLite.

Esta versión es para desarrollo y validación local, no está lista para abrirse directamente a Internet. Antes de producción hacen falta, entre otras cosas, HTTPS y configuración de proxy confiable, límites de intentos por cuenta/IP más robustos y distribuidos, recuperación/verificación de cuentas, política formal de retención, copias de seguridad protegidas, monitoreo y revisión de seguridad. SQLite tampoco cifra la base de datos por sí solo: protege el archivo mediante permisos del sistema operativo y almacenamiento seguro.

Las cuotas de análisis se persisten en la base SQLite para el despliegue de un solo servidor. No compartas ese archivo entre instancias simultáneas ni uses este mecanismo como límite de facturación distribuido. Por defecto, el servidor ignora `X-Forwarded-For` y usa la dirección de la conexión. Si está detrás de un proxy inverso, configura `TRUSTED_PROXY_IPS` con las IP o subredes CIDR exactas de tus proxies (separadas por comas). Solo entonces se aceptará la cadena reenviada, y se recorrerá desde el proxy más cercano. Asegúrate de que el servidor de la aplicación no sea accesible directamente por una ruta que permita suplantar a un proxy confiable.

El score del motor local es heurístico y no representa una probabilidad legal ni un dictamen profesional.

## Modelos Gemini

La lista de modelos se define en `js/audit-engine.js`. Los modelos disponibles pueden cambiar según la cuenta y la API de Google.

## Estructura

```
index.html              Interfaz
css/app.css             Estilos
js/audit-engine.js      Reglas, informe y petición a Gemini
js/app.js               Interfaz, autenticación, archivos e historial
server.js               API, autenticación, Gemini y servidor web
auth-store.js           Persistencia SQLite y credenciales
.env.example            Plantilla de configuración
data/                   Base SQLite creada al iniciar (ignorada por Git)
tests/                  Pruebas automatizadas
```

PDF.js, Mammoth y jsPDF se cargan desde cdnjs con integridad fija. El worker PDF corresponde a PDF.js 3.4.120.
