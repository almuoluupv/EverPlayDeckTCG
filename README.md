# Mi Álbum Pokémon

Escáner de cartas en el navegador y álbum por cuenta. La web estática va en **GitHub Pages**. La API pequeña va en un **Web Service gratuito de Render**. Heroku aparece en el GitHub Student Developer Pack (13 USD al mes durante 24 meses); este proyecto no lo usa.

Sin claves, el escáner y el álbum siguen funcionando en este navegador (`localStorage`).

## Arrancar en local

Hace falta Node 22.

```bash
npm install
npm run dev:web
```

Abre http://127.0.0.1:43123 . Puedes buscar una carta y añadirla al álbum sin base de datos ni login.

La API local solo arranca si `.env` tiene las cuatro variables:

```bash
cp .env.example .env
npm run dev:api
```

Escucha en `0.0.0.0` y en el puerto de `PORT` (en local, 8787). `GET /` responde `{ "ok": true }` y no toca la base de datos. La colección está en `GET` y `PUT /api/collection`.

`.env` y `config.local.js` no se suben a git. La clave secreta de Clerk solo vive en `.env` y, al publicar, en el panel de Render.

## Qué va en cada sitio

| Dónde | Qué pegar |
| --- | --- |
| Render, variables de entorno | `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `MONGODB_URI`, `PAGES_ORIGIN`, `ADMIN_EMAIL` |
| `config.js` (sí se sube, es la web pública) | La misma clave **publicable** de Clerk y la URL pública de Render, sin barra final |
| Clerk, orígenes permitidos | El origen de GitHub Pages, el mismo valor que `PAGES_ORIGIN` |

`PAGES_ORIGIN` es solo el origen, sin ruta y sin barra final: `https://almuoluupv.github.io`. La web vive en `https://almuoluupv.github.io/EverPlayDeckTCG/`, pero el origen que Render debe aceptar no incluye `/EverPlayDeckTCG`. En local puede ser `http://127.0.0.1:43123`.

Tras entrar o salir, Clerk vuelve a `https://almuoluupv.github.io/EverPlayDeckTCG/` (con la carpeta del repositorio y la barra final). No uses la raíz `https://almuoluupv.github.io/`: esa dirección no sirve la web.

Google, también una cuenta nueva, entra por alta (`withSignUp`, `transferable`) y vuelve a esa misma ruta. En el móvil el regreso no puede depender de un ancla `#/sso-callback`: la instancia de desarrollo va sin cookie y el token `__clerk_db_jwt` tiene que ir en la query.

`MONGODB_URI` es la cadena de Atlas del clúster. En Network Access de Atlas permite `0.0.0.0/0`: el plan gratuito de Render no tiene una IP fija de salida. La API guarda el álbum en la base `album`, colección `albums`, como `{ cardId, qty }`.

No hace falta una API key de Render para este repo.

## Orden para publicarlo

1. Sube este repositorio a GitHub y activa GitHub Pages desde la rama `main`, carpeta raíz (`/`). Comprueba en el móvil que la cámara abre y que una carta entra en el álbum. En ese momento `config.js` puede seguir vacío.
2. En Render: **New → Blueprint** (o **Web Service**) y conecta ese repositorio de GitHub, rama `main`. El archivo `render.yaml` deja el servicio `album-pokemon-api` en el plan **Free**, con `npm install` y `npm start`. No crees un segundo servicio para la web: Pages ya la sirve.
3. En el panel del servicio rellena estas variables, con estos nombres exactos:
   - `CLERK_SECRET_KEY`
   - `CLERK_PUBLISHABLE_KEY`
   - `MONGODB_URI`
   - `PAGES_ORIGIN`
   - `ADMIN_EMAIL` (el correo de la cuenta de Clerk que administra; si se deja vacío, el primer usuario que entre queda como admin)
4. Cuando el deploy termine, copia la URL `https://….onrender.com` en `config.js` como `apiBase`, y la clave publicable como `clerkPublishableKey`. Haz commit y push. Pages se actualiza y el botón **Entrar** habla con Render.

La administración no es una pestaña del álbum. Quien sea admin ve el enlace **Administración**, que abre `https://almuoluupv.github.io/EverPlayDeckTCG/admin/`. Cualquier otra cuenta recibe 403 de la API y no ve ese enlace. Hay tres planes (Gratis, Colección y Tienda). El admin fija cuántas cartas —la suma de copias— puede guardar cada plan, y asigna un plan a cada usuario. Al pasar del máximo, la API rechaza el guardado. El navegador envía avisos de error a `POST /api/client-errors` sin fotos de cartas, sin tokens y sin claves.
5. En el panel de Clerk, añade el origen de Pages a los orígenes permitidos.

El plan gratuito de Render se duerme tras unos 15 minutos sin visitas y tarda alrededor de un minuto en volver. Si esa primera llamada falla, el álbum de ese momento se queda en el dispositivo.

Sin sesión, el álbum es solo de este navegador. Con sesión, cada cuenta de Clerk lee y guarda únicamente sus cartas. Lo que añadas sin entrar no pasa a la cuenta, y otra persona que entre no ve ese álbum.

Para regenerar hashes en el ordenador: `npm install sharp` y `node compute_hashes.js`. Ese script no forma parte de la web ni de Render.
