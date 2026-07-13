# CATAN - multiplayer local

Catan base completo para jugar con amigos en el navegador. Server autoritativo
en Node.js + Socket.IO, cliente vanilla JS con tablero SVG estilo juego fisico.

## Como jugar

```bash
npm install
npm start
```

El server queda en `http://localhost:3000`.

1. Uno crea la partida y comparte el **codigo de 4 letras** (o el link
   `http://TU-IP:3000/?code=XXXX`).
2. Los demas entran con el codigo. Hasta 4 jugadores.
3. El anfitrion aprieta "Empezar partida".

### Deploy en Render (URL fija para tus amigos)

El repo trae `render.yaml`, asi que es un deploy de 3 pasos:

1. Subi el repo a GitHub (ya inicializado con git).
2. En [render.com](https://render.com): **New +** > **Blueprint**, conecta tu GitHub
   y elegi este repo. Render lee `render.yaml` y crea el servicio solo.
3. Espera el primer build y listo: te da una URL tipo `https://catan-xxxx.onrender.com`.

Notas del tier gratis: el server se duerme tras ~15 min sin trafico y tarda
~30-60 s en despertar con la primera visita. Las partidas viven en memoria:
si el servicio se reinicia o se duerme, la partida en curso se pierde
(las reconexiones de jugadores individuales si funcionan mientras el server viva).

### Jugar con amigos fuera de tu red

- **Misma WiFi (LAN):** compartis `http://TU-IP-LOCAL:3000` (la ves con `ipconfig`).
  Puede que Windows pregunte por el firewall la primera vez: permitir.
- **Remoto:** un tunel resuelve todo, por ejemplo:
  - `npx localtunnel --port 3000`
  - o Tailscale / ngrok / Cloudflare Tunnel.

## Reglas implementadas (Catan base completo)

- Colocacion inicial en orden serpiente, con recursos por el segundo poblado.
- Dados, reparto de recursos (con regla oficial de escasez del banco).
- 7: descarte de la mitad con mas de 7 cartas, ladron y robo de carta.
- Construccion: caminos, poblados (regla de distancia), ciudades.
- Cartas de desarrollo: caballero, punto de victoria, construccion de caminos,
  año de la abundancia, monopolio. Una por turno, no la recien comprada.
- Gran Ruta Comercial (5+, se corta con poblados rivales) y Gran Ejercito (3+).
- Comercio con el banco 4:1, puertos 3:1 y 2:1, y comercio entre jugadores
  con ofertas que se aceptan/rechazan (prohibido dar y pedir el mismo recurso).
- Victoria a los 10 puntos (los puntos de victoria de cartas quedan ocultos).
  Tambien ganas si llegas a tu turno con 10+ (p. ej. te transfirieron la Gran Ruta).
- Cualquier carta de desarrollo puede jugarse en cualquier momento del turno,
  incluso antes de tirar los dados (una por turno, nunca la recien comprada).
- Orden de turnos aleatorio al empezar la partida.

Verificado contra el reglamento oficial en español (Catan Plus, Devir). Las
expansiones del PDF (ampliacion 5-6 jugadores, Entre amigos, Nueva York,
Mallorca, Los ayudantes) NO estan implementadas: solo el juego basico.

## Extras

- Reconexion automatica: si se te cae el navegador, volves a entrar y seguis
  con tu asiento y tu mano (token en localStorage).
- Chat integrado.

## Desarrollo

```bash
npm test                      # suite completa: tablero, reglas, motor,
                              # simulacion de partidas y test de integracion por sockets
node test/make-dev-state.js   # regenera el estado de ejemplo de dev.html
```

`public/dev.html` muestra la UI con una partida a mitad de juego sin necesidad
de armar una sala (util para tocar estilos).

Estructura:

- `server/game/board.js` - geometria del tablero (hexes, vertices, aristas, puertos)
- `server/game/rules.js` - reglas puras (colocacion, ruta mas larga, reparto, ratios)
- `server/game/engine.js` - maquina de estados de la partida
- `server/index.js` - Express + Socket.IO: salas, reconexion, despacho de acciones
- `public/board.js` - render SVG del tablero
- `public/client.js` - UI y socket del cliente
