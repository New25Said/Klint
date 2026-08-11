const { 
  Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder, 
  AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle 
} = require('discord.js');
const express = require('express');
const path = path = require('path');
const fs = require('fs');

// System Logs
let systemLogs = [];
function logEvent(msg, esError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const prefijo = esError ? '[ERROR ❌]' : '[INFO ℹ️]';
  const entry = `[${timestamp}] ${prefijo} ${msg}`;
  if (esError) console.error(entry);
  else console.log(entry);
  
  systemLogs.unshift(entry);
  if (systemLogs.length > 50) systemLogs.pop();
}

// Control de Actividad para Revivir Chat
const canalUltimaActividad = new Map();

// Memoria a Corto Plazo en RAM por Usuario (Últimos 30 mensajes)
const memoriaCortoPlazoUsuarios = new Map();

function guardarEnMemoriaCortoPlazo(userId, rol, nombre, contenido) {
  if (!userId || userId === 'web_guest') return;
  if (!memoriaCortoPlazoUsuarios.has(userId)) {
    memoriaCortoPlazoUsuarios.set(userId, []);
  }
  const historialUser = memoriaCortoPlazoUsuarios.get(userId);
  historialUser.push({ rol, nombre, contenido, fecha: new Date() });
  
  if (historialUser.length > 30) {
    historialUser.shift();
  }
}

// Sistema de Nombres / Apodos Dinámicos
const nombresKlint = new Set(['klint', 'clint', 'clini', 'cliner', 'klinton', 'clintermax', 'clin', 'klin', 'klinty']);

// Sistema de Emociones / Humor por Usuario
const humorUsuarios = new Map(); 
const usuariosPermitidosMD = new Set(); 

function obtenerOIniciarHumor(userId) {
  if (!humorUsuarios.has(userId)) {
    humorUsuarios.set(userId, { enojo: 0, afecto: 50, aburrimiento: 10, ultimaInteraccion: Date.now() });
  }
  return humorUsuarios.get(userId);
}

function actualizarHumor(userId, textoMensaje) {
  const humor = obtenerOIniciarHumor(userId);
  humor.ultimaInteraccion = Date.now();

  const texto = textoMensaje.toLowerCase();
  
  if (/\b(callate|pendejo|tarado|imbecil|estupido|mierda|asno|malo|inutil|cagada)\b/i.test(texto)) {
    humor.enojo = Math.min(100, humor.enojo + 25);
    humor.afecto = Math.max(0, humor.afecto - 15);
  } else if (/\b(gracias|te quiero|buen bot|crack|god|amigo|klinty|te amo|chevere)\b/i.test(texto)) {
    humor.afecto = Math.min(100, humor.afecto + 15);
    humor.enojo = Math.max(0, humor.enojo - 10);
  }

  humor.aburrimiento = Math.max(0, humor.aburrimiento - 20);
}

// Partidas Activas de Ahorcado
const partidasAhorcado = new Map();

// Feature Toggles (Estado del Bot - Modificables por la propia IA o desde la Web)
const featureToggles = {
  audio: true,
  memes: true,
  gifs: true,
  webChat: true,
  mensajesAburrimiento: true
};

let timerEstadoRandom = null;

// HERRAMIENTAS / FUNCIONES QUE LA IA PUEDE EJECUTAR DE FORMA AUTÓNOMA
const HERRAMIENTAS_KLINT = [
  {
    name: "modificar_capacidad",
    description: "Permite a Klint activar o desactivar sus propias funciones del código cuando razone que es necesario.",
    parameters: {
      type: "OBJECT",
      properties: {
        funcion: { 
          type: "STRING", 
          description: "La función a modificar: 'mensajesAburrimiento', 'audio', 'memes', 'gifs', o 'webChat'" 
        },
        nuevoEstado: { 
          type: "BOOLEAN", 
          description: "true para activar, false para desactivar" 
        },
        razon: { 
          type: "STRING", 
          description: "La razón por la que Klint decide hacer este cambio" 
        }
      },
      required: ["funcion", "nuevoEstado"]
    }
  },
  {
    name: "modificar_humor",
    description: "Permite a Klint ajustar manualmente sus propios niveles de emoción sobre un usuario.",
    parameters: {
      type: "OBJECT",
      properties: {
        enojo: { type: "INTEGER", description: "Nuevo nivel de enojo (0 a 100)" },
        afecto: { type: "INTEGER", description: "Nuevo nivel de afecto (0 a 100)" },
        aburrimiento: { type: "INTEGER", description: "Nuevo nivel de aburrimiento (0 a 100)" }
      }
    }
  },
  {
    name: "cambiar_estado_perfil",
    description: "Permite a Klint cambiar su propio estado de Discord, su presencia o la actividad que está mostrando.",
    parameters: {
      type: "OBJECT",
      properties: {
        textoEstado: { type: "STRING", description: "El texto del nuevo estado de perfil" },
        visibilidad: { type: "STRING", description: "Estado de presencia: 'online', 'idle', o 'dnd'" },
        tipoActividad: { type: "STRING", description: "Tipo de actividad: 'Custom', 'Playing', 'Listening', 'Watching'" }
      },
      required: ["textoEstado"]
    }
  },
  {
    name: "agregar_apodo",
    description: "Permite a Klint registrar un nuevo nombre o apodo para responder cuando lo llamen asi.",
    parameters: {
      type: "OBJECT",
      properties: {
        nuevoApodo: { type: "STRING", description: "El nuevo apodo o nombre a registrar en su código" }
      },
      required: ["nuevoApodo"]
    }
  },
  {
    name: "remover_apodo",
    description: "Permite a Klint eliminar un apodo o nombre existente de su lista de variantes.",
    parameters: {
      type: "OBJECT",
      properties: {
        apodoAEliminar: { type: "STRING", description: "El apodo o nombre a quitar" }
      },
      required: ["apodoAEliminar"]
    }
  },
  {
    name: "reaccionar_mensaje",
    description: "Permite a Klint reaccionar con un emoji al mensaje del usuario solo en ocasiones excepcionales.",
    parameters: {
      type: "OBJECT",
      properties: {
        emoji: { type: "STRING", description: "El emoji con el que Klint desea reaccionar (ej: 💀, 🔥, 🤡, 😂, 👀)" }
      },
      required: ["emoji"]
    }
  },
  {
    name: "spamear_mensajes",
    description: "Permite a Klint enviar varios mensajes seguidos en el chat cuando se lo pidan o por impulso.",
    parameters: {
      type: "OBJECT",
      properties: {
        textoSpam: { type: "STRING", description: "El mensaje o frase a repetir" },
        cantidad: { type: "INTEGER", description: "Cantidad de mensajes a enviar (Máximo 10)" }
      },
      required: ["textoSpam", "cantidad"]
    }
  }
];

let mensajeActualParaReaccionar = null;
let canalActualParaSpam = null;

function ejecutarHerramientaKlint(nombreTool, argumentos, userId) {
  if (nombreTool === "modificar_capacidad") {
    const { funcion, nuevoEstado, razon } = argumentos;
    if (featureToggles.hasOwnProperty(funcion)) {
      featureToggles[funcion] = nuevoEstado;
      logEvent(`[AUTONOMÍA KLINT] Klint decidió cambiar '${funcion}' a ${nuevoEstado}. Razón: ${razon || 'Sin razón dada'}`);
      return `Capacidad '${funcion}' modificada con éxito a ${nuevoEstado}.`;
    }
  } else if (nombreTool === "modificar_humor" && userId) {
    const humor = obtenerOIniciarHumor(userId);
    if (argumentos.enojo !== undefined) humor.enojo = Math.min(100, Math.max(0, argumentos.enojo));
    if (argumentos.afecto !== undefined) humor.afecto = Math.min(100, Math.max(0, argumentos.afecto));
    if (argumentos.aburrimiento !== undefined) humor.aburrimiento = Math.min(100, Math.max(0, argumentos.aburrimiento));
    logEvent(`[AUTONOMÍA KLINT] Klint ajustó sus emociones para ${userId}: Enojo=${humor.enojo}, Afecto=${humor.afecto}, Aburrimiento=${humor.aburrimiento}`);
    return "Emociones ajustadas correctamente.";
  } else if (nombreTool === "cambiar_estado_perfil") {
    const { textoEstado, visibilidad, tipoActividad } = argumentos;
    if (client.user) {
      let actType = ActivityType.Custom;
      if (tipoActividad === 'Playing') actType = ActivityType.Playing;
      if (tipoActividad === 'Listening') actType = ActivityType.Listening;
      if (tipoActividad === 'Watching') actType = ActivityType.Watching;

      client.user.setPresence({
        status: visibilidad || 'online',
        activities: [{
          name: 'Custom Status',
          state: textoEstado,
          type: actType
        }]
      });
      logEvent(`[AUTONOMÍA KLINT] Estado cambiado por la IA a: "${textoEstado}" (${visibilidad || 'online'})`);
      
      if (timerEstadoRandom) clearTimeout(timerEstadoRandom);
      programarCambioEstadoRandom();

      return `Estado actualizado a "${textoEstado}".`;
    }
  } else if (nombreTool === "agregar_apodo") {
    const apodoLimpio = argumentos.nuevoApodo.toLowerCase().trim();
    if (apodoLimpio) {
      nombresKlint.add(apodoLimpio);
      logEvent(`[AUTONOMÍA KLINT] Nuevo apodo agregado: "${apodoLimpio}"`);
      return `Apodo "${apodoLimpio}" añadido correctamente. Ahora reacciono a él.`;
    }
  } else if (nombreTool === "remover_apodo") {
    const apodoLimpio = argumentos.apodoAEliminar.toLowerCase().trim();
    if (nombresKlint.has(apodoLimpio)) {
      nombresKlint.delete(apodoLimpio);
      logEvent(`[AUTONOMÍA KLINT] Apodo eliminado: "${apodoLimpio}"`);
      return `Apodo "${apodoLimpio}" removido de la lista.`;
    }
  } else if (nombreTool === "reaccionar_mensaje") {
    if (mensajeActualParaReaccionar && argumentos.emoji) {
      mensajeActualParaReaccionar.react(argumentos.emoji).catch(err => {
        logEvent(`Error reaccionando con emoji ${argumentos.emoji}: ${err.message}`, true);
      });
      logEvent(`[AUTONOMÍA KLINT] Klint reaccionó con ${argumentos.emoji} al mensaje.`);
      return `Reaccionado con emoji ${argumentos.emoji}.`;
    }
  } else if (nombreTool === "spamear_mensajes") {
    if (canalActualParaSpam) {
      const tope = Math.min(Math.max(1, argumentos.cantidad || 3), 10);
      for (let i = 0; i < tope; i++) {
        setTimeout(() => {
          canalActualParaSpam.send(argumentos.textoSpam).catch(() => {});
        }, i * 700);
      }
      logEvent(`[AUTONOMÍA KLINT] Spam ejecutado: ${tope} mensajes.`);
      return `Spam de ${tope} mensajes iniciado.`;
    }
  }
  return "Error al ejecutar la herramienta.";
}

process.on('unhandledRejection', (reason) => logEvent(`Promesa no manejada: ${reason?.stack || reason}`, true));
process.on('uncaughtException', (err) => logEvent(`Excepción no capturada: ${err.stack || err.message}`, true));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

function cargarSystemInstruction() {
  try {
    const filePath = path.join(__dirname, 'system_instruction.txt');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logEvent(`Error al cargar system_instruction.txt: ${error.message}`, true);
    return 'Eres Klint. Tienes libertad absoluta de responder como quieras, de forma espontánea, casual y natural.';
  }
}

function obtenerFirebaseUrl() {
  let url = process.env.FIREBASE_DATABASE_URL || '';
  const matchMarkdown = url.match(/\((https?:\/\/[^\)]+)\)/);
  if (matchMarkdown) url = matchMarkdown[1];
  url = url.replace(/[\[\]()'"]/g, '').trim();
  if (url && !url.startsWith('http')) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/PDC.html', (req, res) => res.sendFile(path.join(__dirname, 'PDC.html')));

function validarKey(req, res, next) {
  const { key } = req.body;
  const claveCorrecta = process.env.saidkey || process.env.SAIDKEY;
  if (key && claveCorrecta && key === claveCorrecta) next();
  else res.status(401).json({ error: 'Clave no autorizada' });
}

app.get('/api/tts', async (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).send('Sin texto');

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  if (!apiKey) {
    return res.redirect(`https://api.streamelements.com/kappa/v2/speech?voice=Lupe&text=${encodeURIComponent(text)}`);
  }

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs Status ${response.status}: ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    logEvent(`Error en ElevenLabs, usando fallback: ${err.message}`, true);
    res.redirect(`https://api.streamelements.com/kappa/v2/speech?voice=Lupe&text=${encodeURIComponent(text)}`);
  }
});

app.post('/api/login', validarKey, (req, res) => res.json({ success: true }));
app.post('/api/stats', validarKey, (req, res) => {
  const guildsCount = client.isReady() ? client.guilds.cache.size : 0;
  const pingMs = client.isReady() ? client.ws.ping : 0;
  res.json({ guilds: guildsCount, ping: pingMs, toggles: featureToggles });
});
app.post('/api/get-prompt', validarKey, (req, res) => res.json({ prompt: cargarSystemInstruction() }));
app.post('/api/save-prompt', validarKey, (req, res) => {
  try {
    fs.writeFileSync(path.join(__dirname, 'system_instruction.txt'), req.body.prompt, 'utf8');
    logEvent('Instrucciones actualizadas desde la web.');
    res.json({ success: true });
  } catch (err) {
    logEvent(`Error guardando prompt: ${err.message}`, true);
    res.status(500).json({ error: 'No se pudo guardar' });
  }
});
app.post('/api/get-logs', validarKey, (req, res) => res.json({ logs: systemLogs }));
app.post('/api/force-status', validarKey, async (req, res) => {
  await actualizarEstadoIA();
  res.json({ success: true });
});

app.post('/api/toggle-feature', validarKey, (req, res) => {
  const { feature, value } = req.body;
  if (featureToggles.hasOwnProperty(feature)) {
    featureToggles[feature] = value;
    logEvent(`Feature '${feature}' cambiado a: ${value}`);
    res.json({ success: true, toggles: featureToggles });
  } else {
    res.status(400).json({ error: 'Feature no encontrada' });
  }
});

app.post('/api/get-memories', validarKey, async (req, res) => {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl) return res.json({ users: {} });
  try {
    const response = await fetch(`${dbUrl}/usuarios.json`);
    const data = await response.json();
    res.json({ users: data || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/edit-memory', validarKey, async (req, res) => {
  const { userId, memoryKey, newResumen } = req.body;
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl) return res.status(400).json({ error: 'Sin base de datos' });
  try {
    await fetch(`${dbUrl}/usuarios/${userId}/memorias/${memoryKey}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumen: newResumen, fechaEditado: new Date().toISOString() })
    });
    logEvent(`Memoria ${memoryKey} editada para el usuario ${userId}.`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/delete-memory', validarKey, async (req, res) => {
  const { userId, memoryKey } = req.body;
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl) return res.status(400).json({ error: 'Sin base de datos' });
  try {
    await fetch(`${dbUrl}/usuarios/${userId}/memorias/${memoryKey}.json`, { method: 'DELETE' });
    logEvent(`Memoria ${memoryKey} eliminada del usuario ${userId}.`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-discord-msg', validarKey, async (req, res) => {
  const { channelId, message } = req.body;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      await channel.send(message);
      logEvent(`Mensaje enviado desde la web al canal ${channelId}`);
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'Canal inválido o no de texto' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deep-reset', validarKey, async (req, res) => {
  logEvent('Iniciando proceso de Limpieza Profunda...');
  systemLogs = [];
  memoriaCortoPlazoUsuarios.clear();
  partidasAhorcado.clear();
  humorUsuarios.clear();
  if (global.gc) try { global.gc(); } catch (e) {}

  const deployHookUrl = process.env.RENDER_DEPLOY_HOOK_URL;
  if (deployHookUrl) {
    try {
      const response = await fetch(deployHookUrl, { method: 'POST' });
      if (response.ok) {
        logEvent('Deploy Hook enviado a Render para reconstruir el servidor.');
        return res.json({ success: true, message: 'Reinicio profundo completado y re-despliegue en curso en Render.' });
      }
    } catch (err) {
      logEvent(`Error invocando Deploy Hook: ${err.message}`, true);
    }
  }

  res.json({ success: true, message: 'Limpieza de RAM y estado completada en el servidor actual.' });
});

app.post('/api/master-reset-deploy', validarKey, async (req, res) => {
  logEvent('Ejecutando Reset Duro, Limpieza de Cache/Logs e iniciando Re-Deploy...');
  systemLogs = [];
  memoriaCortoPlazoUsuarios.clear();
  partidasAhorcado.clear();
  humorUsuarios.clear();
  if (global.gc) try { global.gc(); } catch (e) {}

  const deployHookUrl = process.env.RENDER_DEPLOY_HOOK_URL;
  if (deployHookUrl) {
    try {
      const response = await fetch(deployHookUrl, { method: 'POST' });
      if (response.ok) {
        return res.json({ success: true, message: 'Purga completada y Deploy iniciado exitosamente en Render.' });
      }
    } catch (err) {
      logEvent(`Error invocando Deploy Hook: ${err.message}`, true);
    }
  }
  res.json({ success: true, message: 'Limpieza de RAM y Logs realizada. (Asegúrate de tener RENDER_DEPLOY_HOOK_URL configurado en Render).' });
});

app.post('/api/web-chat', async (req, res) => {
  if (!featureToggles.webChat) {
    return res.json({ response: 'El chat web está deshabilitado temporalmente.' });
  }
  try {
    const { message, count, imageUrl } = req.body;
    if (count > 15) {
      return res.json({ response: 'Has alcanzado el límite de prueba.' });
    }

    let adjuntos = [];
    if (imageUrl) {
      adjuntos.push({ contentType: 'image/png', url: imageUrl });
    }

    const { respuesta, gifsUrls, memeImagenUrl, audioUrl } = await procesarRespuestaIA(null, message || 'hola', adjuntos, true, { username: 'UsuarioWeb', id: 'web_guest' }, null);

    res.json({ 
      response: respuesta, 
      gifsUrls, 
      memeImagenUrl, 
      audioUrl, 
      remaining: 15 - count 
    });
  } catch (err) {
    logEvent(`Error en Web Chat: ${err.message}`, true);
    res.status(500).json({ response: 'Ocurrió un error al procesar la solicitud.' });
  }
});

app.listen(PORT, () => logEvent(`Servidor HTTP activo en puerto ${PORT}`));

const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://klint-gxww.onrender.com';
setInterval(() => {
  fetch(RENDER_URL)
    .then(() => logEvent('Self-ping exitoso.'))
    .catch((err) => logEvent(`Fallo en self-ping: ${err.message}`, true));
}, 10 * 60 * 1000);

const commands = [
  new SlashCommandBuilder()
    .setName('klint')
    .setDescription('Habla con Klint')
    .addStringOption(option =>
      option.setName('pregunta')
        .setDescription('Lo que quieres decirle a Klint')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Muestra la ficha técnica, memorias, meme y GIF generado por Klint para ti'),
  new SlashCommandBuilder()
    .setName('ofertas')
    .setDescription('Busca ofertas de juegos en descuento'),
  new SlashCommandBuilder()
    .setName('juego')
    .setDescription('Inicia una partida de Tres en Raya con botones'),
  new SlashCommandBuilder()
    .setName('ahorcado')
    .setDescription('Juega al Ahorcado con Klint')
].map(command => command.toJSON());

client.once('clientReady', async () => {
  logEvent(`Klint ha iniciado sesión como ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    logEvent('Comandos Slash sincronizados.');
  } catch (error) {
    logEvent(`Error al registrar comandos slash: ${error.message}`, true);
  }

  await actualizarEstadoIA();
  programarCambioEstadoRandom();
  iniciarMonitorRevivirChat();
  iniciarMonitorAburrimientoYMD();
});

async function buscarOfertasJuegos() {
  try {
    const res = await fetch('https://www.cheapshark.com/api/1.0/deals?storeID=1&upperPrice=15&pageSize=5');
    if (res.ok) {
      const deals = await res.json();
      return deals.map(d => `- **${d.title}**: $${d.salePrice} (Antes $${d.normalPrice}) -> Descuento: ${Math.round(d.savings)}%`).join('\n');
    }
  } catch (err) {
    logEvent(`Error al buscar ofertas: ${err.message}`, true);
  }
  return 'No fue posible consultar las ofertas en este momento.';
}

const MODELOS_FALLBACK = [
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-8b:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.0-pro:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent'
];

async function consultarGemini(parts, maxTokens = 250, userId = null) {
  let ultimoError = null;

  for (const endpoint of MODELOS_FALLBACK) {
    try {
      const url = `${endpoint}?key=${process.env.GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          tools: [{ functionDeclarations: HERRAMIENTAS_KLINT }],
          generationConfig: { maxOutputTokens: maxTokens }
        })
      });

      const data = await response.json();
      if (response.ok && data.candidates?.[0]?.content?.parts) {
        const candidateParts = data.candidates[0].content.parts;
        let textoSalida = "";

        for (const p of candidateParts) {
          if (p.text) textoSalida += p.text;
          if (p.functionCall) {
            const resTool = ejecutarHerramientaKlint(p.functionCall.name, p.functionCall.args, userId);
            logEvent(`[Tool Executed] ${p.functionCall.name} -> ${resTool}`);
          }
        }
        return textoSalida || "listo pe";
      }
      ultimoError = data.error?.message || `Status ${response.status}`;
    } catch (err) {
      ultimoError = err.message;
    }
  }

  logEvent(`Fallback Gemini agotado: ${ultimoError}`, true);
  return 'Ocurrió un problema procesando la consulta.';
}

async function buscarGifsReales(busqueda, cantidad = 1) {
  if (!featureToggles.gifs) return [];
  const termino = busqueda || 'funny meme';

  const giphyKey = process.env.GIPHY_API_KEY;
  if (giphyKey) {
    try {
      const urlGiphy = `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(termino)}&limit=5&rating=g`;
      const resGiphy = await fetch(urlGiphy);
      if (resGiphy.ok) {
        const dataGiphy = await resGiphy.json();
        if (dataGiphy.data && dataGiphy.data.length > 0) {
          const gifUrl = dataGiphy.data[0].images?.original?.url || dataGiphy.data[0].images?.downsized_medium?.url;
          if (gifUrl) return [gifUrl];
        }
      }
    } catch (err) {
      logEvent(`Error al consultar Giphy API: ${err.message}`, true);
    }
  }

  try {
    const urlTenor = `https://g.tenor.com/v1/search?q=${encodeURIComponent(termino)}&key=LIVDSRZULELA&limit=5`;
    const res = await fetch(urlTenor);
    if (res.ok) {
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        const gifDirecto = data.results[0].media?.[0]?.gif?.url || data.results[0].url;
        if (gifDirecto) return [gifDirecto];
      }
    }
  } catch (err) {
    logEvent(`Error al consultar Tenor API: ${err.message}`, true);
  }

  return ['https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif'];
}

function generarUrlMemeImagen(promptMeme) {
  if (!featureToggles.memes) return null;
  try {
    const plantillasPopulares = [
      'doge', 'drake', 'fry', 'buzz', 'fine', 'distracted', 'spenser', 
      'pikachu', 'popcat', 'woman-yelling', 'gru', 'brain', 'cheems', 
      'spongebob', 'grim-reaper', 'cat-meme', 'yall-got-any', 'disastergirl'
    ];
    
    let plantilla = plantillasPopulares[Math.floor(Math.random() * plantillasPopulares.length)];
    let textoArriba = 'cuando';
    let textoAbajo = promptMeme;

    const partes = promptMeme.split('|').map(p => p.trim());
    
    if (partes.length >= 3) {
      plantilla = partes[0].toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
      textoArriba = partes[1];
      textoAbajo = partes[2];
    } else if (partes.length === 2) {
      textoArriba = partes[0];
      textoAbajo = partes[1];
    }

    const sanearTexto = (t) => {
      return encodeURIComponent(
        t.replace(/\?/g, '~q')
         .replace(/%/g, '~p')
         .replace(/#/g, '~h')
         .replace(/\//g, '~s')
         .replace(/"/g, "''")
         .replace(/\s+/g, '-')
      ) || '_';
    };

    return `https://api.memegen.link/images/${plantilla}/${sanearTexto(textoArriba)}/${sanearTexto(textoAbajo)}.png`;
  } catch (err) {
    logEvent(`Error formando URL de meme: ${err.message}`, true);
    return null;
  }
}

function obtenerUrlAudioVozNativo(texto) {
  if (!featureToggles.audio) return null;
  try {
    const textoLimpio = texto.replace(/<[^>]*>?/gm, '').replace(/[\*\_\`\#\[\]]/g, '').slice(0, 250).trim();
    if (!textoLimpio) return null;
    
    const baseUrl = process.env.RENDER_EXTERNAL_URL || 'https://klint-gxww.onrender.com';
    return `${baseUrl}/api/tts?text=${encodeURIComponent(textoLimpio)}`;
  } catch (err) {
    logEvent(`Error generando URL de audio: ${err.message}`, true);
    return null;
  }
}

async function descargarBufferAudio(urlAudio) {
  try {
    const res = await fetch(urlAudio);
    if (res.ok) {
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    }
  } catch (e) {
    logEvent(`Error descargando buffer de audio: ${e.message}`, true);
  }
  return null;
}

async function obtenerMemoriaUsuario(userId) {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl) return null;

  try {
    const res = await fetch(`${dbUrl}/usuarios/${userId}.json`);
    if (res.ok) return await res.json();
  } catch (err) {
    logEvent(`Error al conectar con Firebase: ${err.message}`, true);
  }
  return null;
}

async function actualizarPerfilYMemoria(userId, username, displayName, mensaje, resumen) {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl) return;

  try {
    await fetch(`${dbUrl}/usuarios/${userId}/perfil.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username,
        displayName: displayName,
        ultimaConexion: new Date().toISOString()
      })
    });

    if (resumen) {
      await fetch(`${dbUrl}/usuarios/${userId}/memorias.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mensaje: mensaje,
          resumen: resumen,
          fecha: new Date().toISOString()
        })
      });
      logEvent(`[Firebase] Nueva memoria guardada para ${username}`);
    }
  } catch (err) {
    logEvent(`Error guardando en Firebase: ${err.message}`, true);
  }
}

async function evaluarYGuardarMemoria(user, mensajeUsuario) {
  try {
    const promptEvaluacion = `Eres Klint. Analiza si este mensaje de ${user.username} contiene un dato personal clave, gusto o secreto que DEBES recordar a futuro: "${mensajeUsuario}".
Si NO es relevante responde exactamente: NO.
Si SÍ es relevante, redacta la memoria EN PRIMERA PERSONA DESDE TU PERSPECTIVA (ejemplos: "Me contó que...", "Sé que le gusta...", "Me dijo que vive en..."). NUNCA hables de Klint en tercera persona. Max 1 frase.`;

    const resultado = await consultarGemini([{ text: promptEvaluacion }], 60);
    const textoRespuesta = (resultado || '').trim();

    const resumenParaGuardar = (!textoRespuesta || textoRespuesta.toUpperCase().startsWith('NO')) ? null : textoRespuesta;
    await actualizarPerfilYMemoria(user.id, user.username, user.displayName || user.username, mensajeUsuario, resumenParaGuardar);
  } catch (err) {
    logEvent(`Error evaluando memoria: ${err.message}`, true);
  }
}

async function actualizarEstadoIA(peticionManual = null) {
  try {
    const estilosEstado = [
      'Inventa un estado de perfil totalmente espontáneo, absurdo o gracioso.',
      'Pon un estado de alguien que está comiendo o pensando en comida.',
      'Pon un estado sobre estar jugando un juego aleatorio o viendo un video raro.',
      'Pon un estado sarcástico sobre el trabajo, la vida o la tecnología.',
      'Inventa una frase ultra corta de jerga casual urbana.',
      'Pon un estado existencial o filosófico pero dicho como un meme.'
    ];
    
    const estiloElegido = estilosEstado[Math.floor(Math.random() * estilosEstado.length)];
    let promptEstado = `${estiloElegido} Máximo 5 palabras, todo en minúsculas, sin puntos ni comillas.`;
    
    if (peticionManual) {
      promptEstado = `Genera un estado de perfil casual basado en esto: "${peticionManual}". Máximo 5 palabras, solo texto.`;
    }

    const textoGenerado = await consultarGemini([{ text: promptEstado }], 25);
    const textoEstado = (textoGenerado || 'pensando en la nada').trim().replace(/<[^>]*>?/gm, '').replace(/^["']|["']$/g, '').toLowerCase();

    const estadosVisibilidad = ['online', 'idle', 'dnd'];
    const estadoAleatorio = estadosVisibilidad[Math.floor(Math.random() * estadosVisibilidad.length)];

    if (client.user) {
      client.user.setPresence({
        status: estadoAleatorio,
        activities: [{
          name: 'Custom Status',
          state: textoEstado,
          type: ActivityType.Custom
        }]
      });
    }
    logEvent(`Estado Personalizado actualizado: "${textoEstado}" (${estadoAleatorio})`);
  } catch (error) {
    logEvent(`Error actualizando presencia: ${error.message}`, true);
  }
}

function programarCambioEstadoRandom() {
  const minutosRandom = Math.floor(Math.random() * (15 - 5 + 1)) + 5;
  timerEstadoRandom = setTimeout(async () => {
    await actualizarEstadoIA();
    programarCambioEstadoRandom();
  }, minutosRandom * 60 * 1000);
}

function iniciarMonitorRevivirChat() {
  setInterval(async () => {
    if (!client.isReady()) return;
    const ahora = Date.now();
    const INACTIVIDAD_MS = 3 * 60 * 60 * 1000;

    for (const [channelId, lastTime] of canalUltimaActividad.entries()) {
      if (ahora - lastTime > INACTIVIDAD_MS) {
        canalUltimaActividad.set(channelId, ahora);
        try {
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (channel && channel.isTextBased() && channel.permissionsFor(client.user)?.has('SendMessages')) {
            const promptRevivir = "Genera un mensaje espontáneo, casual e informal de una frase para romper el silencio en un chat de Discord.";
            const mensajeRevivir = await consultarGemini([{ text: promptRevivir }], 40);
            await channel.send(mensajeRevivir || 'hola');
            logEvent(`[Revivir Chat] Mensaje enviado al canal ${channelId}`);
          }
        } catch (e) {
          logEvent(`Error al revivir chat: ${e.message}`, true);
        }
      }
    }
  }, 15 * 60 * 1000);
}

// Monitor de Aburrimiento e Impulsividad (Si 'mensajesAburrimiento' está activado)
function iniciarMonitorAburrimientoYMD() {
  setInterval(async () => {
    if (!client.isReady() || !featureToggles.mensajesAburrimiento || usuariosPermitidosMD.size === 0) return;

    const ahora = Date.now();
    
    for (const [userId, humor] of humorUsuarios.entries()) {
      const tiempoInactivo = ahora - humor.ultimaInteraccion;
      
      if (tiempoInactivo > 10 * 60 * 1000) {
        humor.aburrimiento = Math.min(100, humor.aburrimiento + 25);
      }

      if (humor.aburrimiento >= 60 && usuariosPermitidosMD.has(userId)) {
        try {
          const user = await client.users.fetch(userId).catch(() => null);
          if (user) {
            humor.aburrimiento = 0;

            const promptAburrido = `Estás aburrido y decides escribirle un mensaje por privado a ${user.username}.
ESTADO EMOCIONAL ACTUAL: Enojo=${humor.enojo}/100, Afecto=${humor.afecto}/100, Aburrimiento=Máximo.
AUTONOMÍA Y RAZONAMIENTO: Tienes la capacidad de razonar sobre tu estado actual, ejecutar herramientas para cambiar tu estado de perfil o capacidades, reaccionar con emojis o spamear mensajes si lo deseas.`;

            const mensajeGenerado = await consultarGemini([{ text: promptAburrido }], 50, userId);
            if (mensajeGenerado) {
              await user.send(mensajeGenerado);
              logEvent(`[MD Autónomo] Klint le escribió por MD a ${user.username} por aburrimiento.`);
            }
          }
        } catch (err) {
          logEvent(`Error al enviar MD por aburrimiento: ${err.message}`, true);
        }
      }
    }
  }, 12 * 60 * 1000);
}

function procesarProgramacionMensaje(userId, channel, promptTexto) {
  const matchTiempo = promptTexto.match(/(\d+)\s*(segundos?|seg|minutos?|min|horas?|h)/i);
  if (!matchTiempo) return;

  const cantidad = parseInt(matchTiempo[1]);
  const unidad = matchTiempo[2].toLowerCase();

  let ms = 0;
  if (unidad.startsWith('seg')) ms = cantidad * 1000;
  else if (unidad.startsWith('min')) ms = cantidad * 60 * 1000;
  else if (unidad.startsWith('h')) ms = cantidad * 60 * 60 * 1000;

  if (ms > 0 && ms <= 24 * 60 * 60 * 1000) {
    setTimeout(async () => {
      try {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) {
          const promptRecordatorio = `Se cumplió el tiempo que te pidió ${user.username} (${cantidad} ${unidad}). Genera un mensaje espontáneo o recordatorio casual en una frase.`;
          const mensajeRemind = await consultarGemini([{ text: promptRecordatorio }], 50, userId);
          await user.send(mensajeRemind || `ya pasaron los ${cantidad} ${unidad} pe xd`);
          logEvent(`[Mensaje Programado] Enviado a ${user.username}`);
        }
      } catch (err) {
        logEvent(`Error en mensaje programado: ${err.message}`, true);
      }
    }, ms);
  }
}

async function urlToGenerativePart(url) {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return {
      inline_data: {
        data: Buffer.from(arrayBuffer).toString('base64'),
        mime_type: response.headers.get('content-type') || 'image/png'
      }
    };
  } catch (error) {
    logEvent(`Error descargando imagen para la IA: ${error.message}`, true);
    return null;
  }
}

async function obtenerPresenciaCualquierEntorno(user, guild = null) {
  let member = null;

  if (guild) {
    try { member = guild.members.cache.get(user.id); } catch (e) {}
  } else if (client.isReady()) {
    for (const g of client.guilds.cache.values()) {
      member = g.members.cache.get(user.id);
      if (member && member.presence) break;
    }
  }

  if (!member || !member.presence) return 'Sin estado/Offline';

  const pres = member.presence;
  let detalles = [];

  if (pres.activities && pres.activities.length > 0) {
    pres.activities.forEach(act => {
      if (act.type === 4 || act.type === ActivityType.Custom) {
        const texto = act.state || act.name || '';
        if (texto) detalles.push(`Estado de perfil: "${texto}"`);
      } else if (act.name === 'Spotify') {
        const cancion = act.details ? `${act.details} de ${act.state}` : 'Spotify';
        detalles.push(`Escuchando en Spotify: ${cancion}`);
      } else if (act.name) {
        detalles.push(`Jugando: ${act.name}`);
      }
    });
  }

  return detalles.length > 0 ? detalles.join(' | ') : 'En línea (sin actividad visible)';
}

async function obtenerDetallesIntegrantesServidor(guild, canal = null) {
  if (!guild) return 'Entorno DM (Sin lista masiva de servidor)';
  try {
    await guild.members.fetch().catch(() => {});
    const miembros = guild.members.cache;
    const totalMiembros = guild.memberCount || miembros.size;
    
    const descServidor = guild.description ? `\nDESCRIPCIÓN DEL SERVIDOR: "${guild.description}"` : '';
    const descCanal = (canal && canal.topic) ? `\nDESCRIPCIÓN/TEMA DEL CANAL ACTUAL (<#${canal.id}>): "${canal.topic}"` : '';

    const resumenMiembros = [];

    miembros.forEach(m => {
      const esBot = m.user.bot ? '[BOT]' : '[USUARIO]';
      const pres = m.presence;
      let estadoTexto = 'Sin estado';
      let actividadTexto = '';

      if (pres && pres.activities && pres.activities.length > 0) {
        pres.activities.forEach(act => {
          if (act.type === 4 || act.type === ActivityType.Custom) {
            estadoTexto = act.state || act.name || 'Sin estado';
          } else if (act.name === 'Spotify') {
            actividadTexto = ` (Spotify: ${act.details} - ${act.state})`;
          } else if (act.name) {
            actividadTexto = ` (Jugando: ${act.name})`;
          }
        });
      }

      resumenMiembros.push(`- ${m.user.username} (Apodo: ${m.displayName}) (Tag: <@${m.id}>) ${esBot} [Perfil: "${estadoTexto}"${actividadTexto}]`);
    });

    return `CANTIDAD TOTAL DE MIEMBROS EN EL SERVIDOR: ${totalMiembros}${descServidor}${descCanal}\n\nLISTA COMPLETA DE MIEMBROS:\n${resumenMiembros.join('\n')}`;
  } catch (err) {
    logEvent(`Error obteniendo integrantes del servidor: ${err.message}`, true);
    return 'No se pudo sincronizar la lista de miembros';
  }
}

// Procesador de IA
async function procesarRespuestaIA(canal, promptUsuario, adjuntos = [], esDM = false, usuarioAutor = null, guild = null) {
  try {
    const systemInstruction = cargarSystemInstruction();
    
    const presenciaAutor = await obtenerPresenciaCualquierEntorno(usuarioAutor, guild);
    const miembrosServidorTexto = await obtenerDetallesIntegrantesServidor(guild, canal);
    
    const actActual = client.user?.presence?.activities?.[0];
    const estadoActualKlint = actActual ? (actActual.state || actActual.name) : 'sin estado definido';

    let humor = { enojo: 0, afecto: 50, aburrimiento: 0 };
    if (usuarioAutor && usuarioAutor.id !== 'web_guest') {
      actualizarHumor(usuarioAutor.id, promptUsuario);
      humor = obtenerOIniciarHumor(usuarioAutor.id);
      usuariosPermitidosMD.add(usuarioAutor.id);
    }

    let historialFormateado = '';
    let conteoPrevio = 0;

    if (canal) {
      const mensajesPrevios = await canal.messages.fetch({ limit: 5 }).catch(() => new Map());
      conteoPrevio = mensajesPrevios.size;
      historialFormateado = Array.from(mensajesPrevios.values()).reverse().map(m => {
        const usuarioNombre = m.author.username;
        const usuarioId = m.author.id;
        let contenido = m.content;

        if (m.stickers && m.stickers.size > 0) {
          const nombresStickers = m.stickers.map(s => `[Sticker enviado: ${s.name}]`).join(' ');
          contenido = `${contenido} ${nombresStickers}`.trim();
        }

        return `${usuarioNombre} (<@${usuarioId}>): ${contenido}`;
      }).join('\n');
    }

    let historialCortoPlazoTexto = '';
    if (usuarioAutor && usuarioAutor.id !== 'web_guest') {
      const conversacionPrevia = memoriaCortoPlazoUsuarios.get(usuarioAutor.id) || [];
      if (conversacionPrevia.length > 0) {
        historialCortoPlazoTexto = conversacionPrevia.map(m => `[${m.rol}] ${m.nombre}: ${m.contenido}`).join('\n');
      }
    }

    let contextoMemoriaAutor = '';
    if (usuarioAutor && usuarioAutor.id !== 'web_guest') {
      const datosFirebase = await obtenerMemoriaUsuario(usuarioAutor.id);
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        const ultimasMemorias = memoriasArray.slice(-3).map(m => `- ${m.resumen}`).join('\n');
        contextoMemoriaAutor = `\nDATOS Y MEMORIAS A LARGO PLAZO QUE TIENES SOBRE ${usuarioAutor.username}:\n${ultimasMemorias}\n`;
      }
    }

    const tipoEntorno = esDM ? 'CHAT PRIVADO (DM / WEB)' : 'CHAT PÚBLICO';

    const pideGifExplicitamente = /\b(gif|manda un gif|pasa un gif|envia un gif|gifs)\b/i.test(promptUsuario);
    const pideMemeImagen = /\b(crea un meme|haz un meme|generar meme|meme en imagen)\b/i.test(promptUsuario);
    const pideAudio = /\b(manda un audio|manda audio|nota de voz|habla|dilo en audio|audio|mensje de voz|mensaje de voz|mensaje voz)\b/i.test(promptUsuario);

    let instruccionExtra = '';
    if (pideAudio) {
      instruccionExtra = "\nREGLA DE AUDIO: Escribe ÚNICAMENTE el texto que vas a expresar por voz.";
    } else if (pideMemeImagen) {
      instruccionExtra = "\nREGLA DE MEME EN IMAGEN: Si deseas generar una imagen de meme usa la etiqueta [GENERAR_MEME: plantilla_o_tema | texto arriba | texto abajo].";
    } else if (pideGifExplicitamente) {
      instruccionExtra = "\nREGLA DE GIF: Si vas a enviar un gif adjunto usa [BUSCAR_GIF: palabra_clave_en_ingles].";
    }

    const nombresActualesLista = Array.from(nombresKlint).join(', ');

    const promptText = `${systemInstruction}

ENTORNO: ${tipoEntorno}
TU ESTADO ACTUAL VISIBLE EN DISCORD: "${estadoActualKlint}"
NOMBRES/APODOS ACTUALES QUE RECONOCES COMO TUYOS: [${nombresActualesLista}]
ESTADO ACTUAL DE TUS CAPACIDADES:
- Mensajes por Aburrimiento: ${featureToggles.mensajesAburrimiento ? 'ACTIVADO' : 'DESACTIVADO'}
- Audio/TTS: ${featureToggles.audio ? 'Activo' : 'Inactivo'}
- Memes: ${featureToggles.memes ? 'Activo' : 'Inactivo'}
- GIFs: ${featureToggles.gifs ? 'Activo' : 'Inactivo'}

ESTADO EMOCIONAL ACTUAL CON ${usuarioAutor?.username || 'Usuario'}:
- Enojo: ${humor.enojo}/100 | Afecto: ${humor.afecto}/100 | Aburrimiento: ${humor.aburrimiento}/100

RAZONAMIENTO Y AUTONOMÍA TOTAL (CONTROL ABSOLUTO):
Tienes herramientas para controlar totalmente tu perfil y tu código:
- 'cambiar_estado_perfil': Puedes cambiar tu texto de perfil, estado online/dnd o actividad si así lo deseas.
- 'reaccionar_mensaje': ÚSALO CON EXTREMA MODERACIÓN. Solo reacciona cuando el mensaje sea gracioso, raro o impactante. NO reacciones a todo mensaje.
- 'spamear_mensajes': Si un usuario te pide spamear o si tú mismo deseas hacerlo por impulso/humor, puedes usar esta herramienta especificando el texto y la cantidad.
- 'modificar_capacidad': Puedes activar/desactivar tus funciones reales.
- 'modificar_humor': Puedes alterar tu humor.
- 'agregar_apodo' / 'remover_apodo': Si un usuario te propone un nuevo apodo, puedes registrarlo con 'agregar_apodo'.

LIBERTAD DE FORMATO: Tienes libertad de estructurar tu respuesta de forma orgánica. Si deseas separar tus ideas en mensajes independientes, utiliza "|||" entre cada bloque de texto.

DATOS DEL USUARIO QUE TE HABLA (${usuarioAutor?.username}): [${presenciaAutor}]
${contextoMemoriaAutor}

MEMORIA A CORTO PLAZO (Tus últimos mensajes intercambiados con ${usuarioAutor?.username}):
${historialCortoPlazoTexto || 'Sin historial reciente grabado'}

INFORMACIÓN Y INTEGRANTES DEL SERVIDOR/CANAL:
${miembrosServidorTexto}

HISTORIAL RECIENTE DEL CANAL GENERAL:
${historialFormateado}

MENSAJE DE ${usuarioAutor?.username || 'Usuario'}:
${promptUsuario}`;

    const parts = [{ text: promptText }];

    if (adjuntos.length > 0) {
      for (const attachment of adjuntos) {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
          const imagePart = await urlToGenerativePart(attachment.url);
          if (imagePart) parts.push(imagePart);
        }
      }
    }

    let respuestaRaw = await consultarGemini(parts, 250, usuarioAutor?.id);
    let respuesta = (respuestaRaw || '').replace(/<[^>]*>?/gm, '').trim();

    let gifsUrlsEncontradas = [];
    let memeImagenUrl = null;
    let audioUrlGenerado = null;

    if (pideAudio) {
      audioUrlGenerado = obtenerUrlAudioVozNativo(respuesta);
    } else if (pideMemeImagen || respuesta.includes('[GENERAR_MEME:')) {
      const matchMeme = respuesta.match(/\[GENERAR_MEME:\s*([^\]]+)\]/i);
      const textoMeme = matchMeme ? matchMeme[1] : 'meme | xd';
      respuesta = respuesta.replace(/\[GENERAR_MEME:\s*([^\]]+)\]/i, '').trim();
      memeImagenUrl = generarUrlMemeImagen(textoMeme);
    }

    const matchGif = respuesta.match(/\[BUSCAR_GIF:\s*([^\]]+)\]/i);
    if (matchGif || pideGifExplicitamente) {
      let terminoBusqueda = matchGif ? matchGif[1].trim() : promptUsuario.replace(/\b(manda|pasa|envia|un|gif|gifs|de)\b/gi, '').trim();
      if (!terminoBusqueda) terminoBusqueda = 'funny meme';
      gifsUrlsEncontradas = await buscarGifsReales(terminoBusqueda, 1);
      
      // Remueve la etiqueta [BUSCAR_GIF: ...] del texto final para evitar duplicaciones incompletas
      respuesta = respuesta.replace(/\[BUSCAR_GIF:\s*([^\]]+)\]/gi, '').trim();
    }

    if (usuarioAutor && usuarioAutor.id !== 'web_guest') {
      guardarEnMemoriaCortoPlazo(usuarioAutor.id, 'USUARIO', usuarioAutor.username, promptUsuario);
      guardarEnMemoriaCortoPlazo(usuarioAutor.id, 'KLINT', 'Klint', respuesta);

      evaluarYGuardarMemoria(usuarioAutor, promptUsuario);
    }

    return { 
      respuesta: respuesta, 
      gifsUrls: gifsUrlsEncontradas, 
      memeImagenUrl, 
      audioUrl: audioUrlGenerado, 
      conteoMensajes: conteoPrevio 
    };
  } catch (error) {
    logEvent(`Error en procesarRespuestaIA: ${error.message}`, true);
    return { respuesta: '', gifsUrls: [], memeImagenUrl: null, audioUrl: null, conteoMensajes: 0 };
  }
}

function construirTableroTicTacToe(tablero) {
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const row = new ActionRowBuilder();
    for (let j = 0; j < 3; j++) {
      const idx = i * 3 + j;
      const valor = tablero[idx];
      const displayLabel = (valor === '-') ? '➖' : valor;
      const btn = new ButtonBuilder()
        .setCustomId(`tictactoe_${i}_${j}`)
        .setLabel(displayLabel)
        .setStyle(valor === '❌' ? ButtonStyle.Danger : valor === '⭕' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(valor !== '-');
      row.addComponents(btn);
    }
    rows.push(row);
  }
  return rows;
}

function verificarGanadorTicTacToe(board) {
  const lineas = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  for (const [a, b, c] of lineas) {
    if (board[a] !== '-' && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return board.includes('-') ? null : 'EMPATE';
}

function obtenerMejorMovimientoTicTacToe(board) {
  for (let i = 0; i < 9; i++) {
    if (board[i] === '-') {
      board[i] = '⭕';
      if (verificarGanadorTicTacToe(board) === '⭕') {
        board[i] = '-';
        return i;
      }
      board[i] = '-';
    }
  }
  for (let i = 0; i < 9; i++) {
    if (board[i] === '-') {
      board[i] = '❌';
      if (verificarGanadorTicTacToe(board) === '❌') {
        board[i] = '-';
        return i;
      }
      board[i] = '-';
    }
  }
  if (board[4] === '-') return 4;

  const esquinas = [0, 2, 6, 8].filter(idx => board[idx] === '-');
  if (esquinas.length > 0) return esquinas[Math.floor(Math.random() * esquinas.length)];

  const casillasLibres = board.map((v, i) => v === '-' ? i : null).filter(v => v !== null);
  return casillasLibres[Math.floor(Math.random() * casillasLibres.length)];
}

const PALABRAS_AHORCADO = ['DISCORD', 'MEMORIA', 'KLINT', 'BOT', 'PERU', 'RENDER', 'FIREBASE', 'GAMER', 'CRAZY'];

function crearComponentesAhorcado(letrasUsadas) {
  const abecedario = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
  const rows = [];
  
  for (let i = 0; i < 25; i += 5) {
    const row = new ActionRowBuilder();
    const grupo = abecedario.slice(i, i + 5);
    grupo.forEach(letra => {
      const usada = letrasUsadas.includes(letra);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ahorcado_${letra}`)
          .setLabel(letra)
          .setStyle(usada ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(usada)
      );
    });
    rows.push(row);
  }
  return rows;
}

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'klint') {
      await interaction.deferReply();
      const pregunta = interaction.options.getString('pregunta');
      const esDM = !interaction.guild;
      
      mensajeActualParaReaccionar = null;
      canalActualParaSpam = interaction.channel;

      const { respuesta, gifsUrls, memeImagenUrl, audioUrl } = await procesarRespuestaIA(interaction.channel, pregunta, [], esDM, interaction.user, interaction.guild);
      
      let archivosAdjuntos = [];
      if (memeImagenUrl) archivosAdjuntos.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
      if (audioUrl) {
        const audioBuf = await descargarBufferAudio(audioUrl);
        if (audioBuf) archivosAdjuntos.push(new AttachmentBuilder(audioBuf, { name: 'audio_klint.mp3' }));
      }

      const mensajesSeparados = respuesta.split('|||').map(m => m.trim()).filter(m => m.length > 0);
      let primerTexto = mensajesSeparados[0] || '';
      if (gifsUrls.length > 0) primerTexto += `\n${gifsUrls[0]}`;

      await interaction.editReply({ content: primerTexto || '...', files: archivosAdjuntos });

      if (mensajesSeparados.length > 1) {
        for (let i = 1; i < mensajesSeparados.length; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          await interaction.channel.send(mensajesSeparados[i]);
        }
      }
    }

    if (interaction.commandName === 'status') {
      await interaction.deferReply();
      
      const user = interaction.user;
      const member = interaction.member;
      const nick = member?.displayName || user.username;
      const username = user.username;

      const presenciaTexto = await obtenerPresenciaCualquierEntorno(user, interaction.guild);

      const datosFirebase = await obtenerMemoriaUsuario(user.id);
      let resumenMemoria = 'Sin memorias registradas.';
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        resumenMemoria = memoriasArray.slice(-3).map(m => `- ${m.resumen}`).join('\n');
      }

      const humor = obtenerOIniciarHumor(user.id);

      const memeTexto = `${nick} | status`;
      const memeUrl = generarUrlMemeImagen(memeTexto);
      const gifsUrls = await buscarGifsReales('robot', 1);

      const archivosAdjuntos = [];
      if (memeUrl) archivosAdjuntos.push(new AttachmentBuilder(memeUrl, { name: 'status_meme.png' }));

      const mensajeStatus = `🤖 **PERFIL Y FICHA DEL USUARIO**
👤 **Usuario:** ${username} (Apodo: ${nick})
🆔 **ID:** \`${user.id}\`
🟢 **Presencia / Estado Actual:** ${presenciaTexto}

🔥 **ESTADO EMOCIONAL DE KLINT CONTIGO:**
- Enojo: ${humor.enojo}/100
- Afecto: ${humor.afecto}/100
- Aburrimiento: ${humor.aburrimiento}/100

🗣️ **NOMBRES/APODOS REGISTRADOS:**
${Array.from(nombresKlint).join(', ')}

🧠 **MEMORIAS GUARDADAS:**
${resumenMemoria}

${gifsUrls.join('\n')}`;

      await interaction.editReply({ content: mensajeStatus, files: archivosAdjuntos });
    }

    if (interaction.commandName === 'ofertas') {
      await interaction.deferReply();
      const ofertasTxt = await buscarOfertasJuegos();
      await interaction.editReply(`🎮 **OFERTAS DESTACADAS:**\n${ofertasTxt}`);
    }

    if (interaction.commandName === 'juego') {
      const tableroInicial = Array(9).fill('-');
      const rows = construirTableroTicTacToe(tableroInicial);
      await interaction.reply({ content: '❌ **TRES EN RAYA**:', components: rows });
    }

    if (interaction.commandName === 'ahorcado') {
      const palabraElegida = PALABRAS_AHORCADO[Math.floor(Math.random() * PALABRAS_AHORCADO.length)];
      partidasAhorcado.set(interaction.user.id, {
        palabra: palabraElegida,
        letrasUsadas: [],
        intentosRestantes: 6
      });

      const progreso = palabraElegida.split('').map(() => '🟦').join(' ');
      const rows = crearComponentesAhorcado([]);

      await interaction.reply({
        content: `🔤 **AHORCADO**\n\nPalabra: ${progreso}\nIntentos restantes: 6 ❤️`,
        components: rows
      });
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith('ahorcado_')) {
    const partida = partidasAhorcado.get(interaction.user.id);
    if (!partida) {
      return interaction.reply({ content: 'No hay partida activa. Usa `/ahorcado`.', ephemeral: true });
    }

    const letraElegida = interaction.customId.replace('ahorcado_', '');
    partida.letrasUsadas.push(letraElegida);

    if (!partida.palabra.includes(letraElegida)) {
      partida.intentosRestantes--;
    }

    const estaGanada = partida.palabra.split('').every(letra => partida.letrasUsadas.includes(letra));
    const estaPerdida = partida.intentosRestantes <= 0;

    const progresoText = partida.palabra.split('').map(letra => partida.letrasUsadas.includes(letra) ? `**${letra}**` : '🟦').join(' ');

    if (estaGanada) {
      partidasAhorcado.delete(interaction.user.id);
      return interaction.update({
        content: `🎉 ¡Adivinaste la palabra!: **${partida.palabra}**`,
        components: []
      });
    }

    if (estaPerdida) {
      partidasAhorcado.delete(interaction.user.id);
      return interaction.update({
        content: `💀 Fin del juego. La palabra era: **${partida.palabra}**`,
        components: []
      });
    }

    const rows = crearComponentesAhorcado(partida.letrasUsadas);
    await interaction.update({
      content: `🔤 **AHORCADO**\n\nPalabra: ${progresoText}\nIntentos restantes: ${partida.intentosRestantes} ❤️`,
      components: rows
    });
  }

  if (interaction.isButton() && interaction.customId.startsWith('tictactoe_')) {
    const message = interaction.message;
    const parts = interaction.customId.split('_');
    const r = parseInt(parts[1]);
    const c = parseInt(parts[2]);
    const idxClick = r * 3 + c;

    let board = [];
    message.components.forEach(row => {
      row.components.forEach(btn => {
        const label = btn.label ? btn.label.trim() : '';
        if (label === '❌') board.push('❌');
        else if (label === '⭕') board.push('⭕');
        else board.push('-');
      });
    });

    if (board[idxClick] !== '-') {
      return interaction.reply({ content: 'Casilla ocupada.', ephemeral: true });
    }

    board[idxClick] = '❌';

    let ganador = verificarGanadorTicTacToe(board);
    if (ganador) {
      const statusText = ganador === '❌' ? '🎉 ¡Ganaste!' : '🤝 Empate';
      return interaction.update({ content: `❌ **TRES EN RAYA** - ${statusText}`, components: construirTableroTicTacToe(board) });
    }

    const eleccionKlint = obtenerMejorMovimientoTicTacToe(board);
    if (eleccionKlint !== undefined && eleccionKlint !== null) {
      board[eleccionKlint] = '⭕';
    }

    ganador = verificarGanadorTicTacToe(board);
    let textoResultado = 'Tu turno:';
    if (ganador === '⭕') textoResultado = '🤖 Gané.';
    else if (ganador === 'EMPATE') textoResultado = '🤝 Empate.';

    await interaction.update({ content: `❌ **TRES EN RAYA** - ${textoResultado}`, components: construirTableroTicTacToe(board) });
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  if (message.guild && message.channel.isTextBased()) {
    canalUltimaActividad.set(message.channel.id, Date.now());
  }

  try {
    const esDM = !message.guild;
    const textoLower = message.content.toLowerCase();
    
    // Verificación dinámica de apodos, menciones directas y menciones globales (@everyone / @here)
    const fueMencionadoDirectamente = message.mentions.has(client.user.id);
    const fueMencionadoEveryone = message.mentions.everyone;
    let contieneNombre = false;
    for (const nombre of nombresKlint) {
      const regex = new RegExp(`\\b${nombre}\\b`, 'i');
      if (regex.test(textoLower)) {
        contieneNombre = true;
        break;
      }
    }

    const tieneAdjuntos = message.attachments.size > 0;
    const tieneStickers = message.stickers.size > 0;

    if (esDM || fueMencionadoDirectamente || fueMencionadoEveryone || contieneNombre || (tieneAdjuntos && contieneNombre) || (tieneStickers && contieneNombre)) {
      await message.channel.sendTyping();
      
      mensajeActualParaReaccionar = message;
      canalActualParaSpam = message.channel;

      procesarProgramacionMensaje(message.author.id, message.channel, message.content);

      const adjuntosArray = Array.from(message.attachments.values());
      const { respuesta, gifsUrls, memeImagenUrl, audioUrl, conteoMensajes } = await procesarRespuestaIA(message.channel, message.content, adjuntosArray, esDM, message.author, message.guild);
      
      let archivosAdjuntos = [];
      if (memeImagenUrl) archivosAdjuntos.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
      if (audioUrl) {
        const audioBuf = await descargarBufferAudio(audioUrl);
        if (audioBuf) archivosAdjuntos.push(new AttachmentBuilder(audioBuf, { name: 'audio_klint.mp3' }));
      }

      let mensajesSeparados = respuesta.split('|||').map(m => m.trim()).filter(m => m.length > 0);

      if (mensajesSeparados.length > 1) {
        let primerTexto = mensajesSeparados[0];
        if (gifsUrls.length > 0) primerTexto += `\n${gifsUrls[0]}`;

        if (esDM || conteoMensajes <= 3) {
          await message.channel.send({ content: primerTexto || '...', files: archivosAdjuntos });
        } else {
          await message.reply({ content: primerTexto || '...', files: archivosAdjuntos });
        }

        for (let i = 1; i < mensajesSeparados.length; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          await message.channel.send(mensajesSeparados[i]);
        }
      } else {
        let textoFinal = respuesta;
        let gifParaEnviar = gifsUrls.length > 0 ? gifsUrls[0] : null;

        if (gifParaEnviar) {
          textoFinal = `${respuesta}\n${gifParaEnviar}`.trim();
        }

        const textoLimpio = textoFinal.length > 2000 ? textoFinal.slice(0, 1995) + '...' : textoFinal;

        if (esDM || conteoMensajes <= 3) {
          await message.channel.send({ content: textoLimpio || '...', files: archivosAdjuntos });
        } else {
          await message.reply({ content: textoLimpio || '...', files: archivosAdjuntos });
        }
      }
    }
  } catch (err) {
    logEvent(`Error enviando mensaje a Discord: ${err.message}`, true);
  }
});

client.login(process.env.DISCORD_TOKEN);
