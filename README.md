<div align="center">

  <img src="https://cdn.discordapp.com/avatars/1535688886326530198/avatar.png" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'" width="120" height="120" style="border-radius: 50%; border: 4px solid #8b5cf6;" alt="Klint AI Avatar">

  # 🤖 Klint AI — Autonomous Discord Bot & Core Engine

  **Bot multitarea autónomo impulsado por Gemini AI, síntesis de voz MP3, generación de memes en tiempo real, motor de GIFs y panel de control Web Express.**

  [![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
  [![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.js.org/)
  [![Google Gemini](https://img.shields.io/badge/Google_Gemini-3.5_Flash-8E75B2?style=for-the-badge&logo=google&logoColor=white)](https://ai.google.dev/)
  [![Firebase](https://img.shields.io/badge/Firebase-Realtime_DB-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)](https://firebase.google.com/)
  [![Express](https://img.shields.io/badge/Express.js-Dashboard_Web-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
  [![Render](https://img.shields.io/badge/Render-Deployed-46E3B7?style=for-the-badge&logo=render&logoColor=black)](https://render.com/)

  ---

  [➕ Agregar Bot a Servidor](https://discord.com/oauth2/authorize?client_id=1535688886326530198&permissions=8&integration_type=0&scope=bot+applications.commands) •
  [📱 Agregar a Mis Apps](https://discord.com/oauth2/authorize?client_id=1535688886326530198)

</div>

---

## ⚡ Descripción General

**Klint** es un sistema autónomo de inteligencia artificial conversacional para Discord desarrollado con `discord.js v14` y `Express`. Está integrado con modelos **Google Gemini (fallback multinivel)**, base de datos no relacional **Firebase Realtime DB**, sintetizador de voz nativo en **MP3**, motor de memes generativos y conexión directa con APIs de medios multimedia.

---

## ✨ Capacidades & Funciones Clave

| Categoría | Función | Descripción Técnica |
| :--- | :--- | :--- |
| 🧠 **IA Conversacional** | **Fallback Multi-Modelo** | Sistema redundante que commuta automáticamente entre `gemini-3.5-flash-lite`, `gemini-3.5-flash` y `gemini-2.5-flash` para garantizar respuestas continuas sin interrupción. |
| 🎙️ **Audio / Voz** | **Sintetizador MP3 Nativo** | Convierte las respuestas solicitadas a audio `.mp3` generado dinámicamente mediante Google TTS API y lo adjunta en el canal. |
| 🖼️ **Generador Memes** | **Renderizado de Memes** | Procesa solicitudes de memes, selecciona plantillas aleatorias (`doge`, `drake`, `fry`, `buzz`, `fine`, `distracted`, `spenser`) y genera un archivo `.png` mediante `Memegen API`. |
| 🎞️ **Motor de GIFs** | **Tenor v1 API Stream** | Extrae y adjunta directo al canal de 1 hasta 2 archivos `.gif` animados reales filtrados por términos clave. |
| 👀 **Presencia & Contexto** | **Lectura en Tiempo Real** | Detecta nicknames del servidor, estados personalizados de perfil, canciones en ejecución en **Spotify** y actividad de juegos de los usuarios en línea. |
| 💾 **Memoria Persistente** | **Base de Datos Firebase** | Evalúa de forma automática si un mensaje contiene datos clave del usuario y guarda los recuerdos de forma permanente en Firebase Realtime DB. |
| ⚡ **Auto-Presencia** | **Custom Status Rotativo** | Tarea programada (intervalo variable entre 7 y 35 min) que actualiza la presencia del bot en Discord con frases espontáneas generadas por IA. |
| 🌐 **Dashboard Web** | **Panel Express & Sandbox** | Interfaz web completa con autenticación protegida por clave, editor de System Instructions, visor de logs en vivo, sandbox de prueba y reinicio profundo. |

---

## 🚀 Comandos Slash (Discord)

| Comando | Descripción |
| :--- | :--- |
| `/klint [pregunta]` | Inicia una interacción directa con la IA pasando el parámetro de texto e historial del canal. |
| `/status` | Muestra la ficha técnica del usuario que ejecuta el comando: recuerdos guardados en Firebase, apodo/username, meme personalizado generado en el acto y un GIF animado de celebración. |

---

## 🛠️ Arquitectura del Dashboard Web & APIs REST

El servidor `Express` expone endpoints RESTful en el puerto configurado (`PORT: 10000` por defecto) para administración remota y pruebas:
