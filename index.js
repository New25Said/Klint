const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  ActivityType, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  AttachmentBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle 
} = require('discord.js');
const express = require('express');
const path = require('path');
const fs = require('fs');

// ==========================================
// REGISTRO Y SISTEMA DE LOGS INTERNOS
// ==========================================
let systemLogs = [];

/**
 * Registra un evento en la consola y lo almacena en la lista global de logs
 * @param {string} msg - Mensaje o evento a registrar
 * @param {boolean} esError - Indica si el log es un error
 */
function logEvent(msg, esError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const prefijo = esError ? '[ERROR ❌]' : '[INFO ℹ️]';
  const entry = `[${timestamp}] ${prefijo} ${msg}`;
  
  if (esError) {
    console.error(entry);
  } else {
    console.log(entry);
  }
  
  systemLogs.unshift(entry);
  if (systemLogs.length > 50) {
    systemLogs.pop();
  }
}

// Controladores de excepciones globales
process.on('unhandledRejection', (reason) => {
  logEvent(`Promesa no manejada detectada: ${reason?.stack || reason}`, true);
});

process.on('uncaughtException', (err) => {
  logEvent(`Excepción no capturada detectada: ${err.stack || err.message}`, true);
});

// ==========================================
// CONFIGURACIÓN Y TOGGLES EN TIEMPO REAL
// ==========================================
const featureToggles = {
  audio: true,
  memes: true,
  gifs: true,
  webChat: true
};

/**
 * Lee el archivo de instrucciones del sistema local
 * @returns {string} Texto de instrucciones para el prompt
 */
function cargarSystemInstruction() {
  try {
    const filePath = path.join(__dirname, 'system_instruction.txt');
    const contenido = fs.readFileSync(filePath, 'utf8');
    return contenido;
  } catch (error) {
    logEvent(`Error al cargar el archivo system_instruction.txt: ${error.message}`, true);
    return 'Eres Klint. Habla casual en minúsculas, respuestas super cortas e informales.';
  }
}

/**
 * Formatea y limpia la URL de la base de datos de Firebase
 * @returns {string} URL formateada
 */
function obtenerFirebaseUrl() {
  let url = process.env.FIREBASE_DATABASE_URL || '';
  const matchMarkdown = url.match(/\((https?:\/\/[^\)]+)\)/);
  if (matchMarkdown) {
    url = matchMarkdown[1];
  }
  url = url.replace(/[\[\]()'"]/g, '').trim();
  if (url && !url.startsWith('http')) {
    url = `https://${url}`;
  }
  return url;
}

// ==========================================
// SERVIDOR WEB Y ENDPOINTS EXPRES
// ==========================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/**
 * Middleware para validar la clave de administración
 */
function validarKey(req, res, next) {
  const { key } = req.body;
  const claveCorrecta = process.env.saidkey || process.env.SAIDKEY;
  if (key && claveCorrecta && key === claveCorrecta) {
    next();
  } else {
    res.status(401).json({ error: 'Clave no autorizada' });
  }
}

app.post('/api/login', validarKey, (req, res) => {
  res.json({ success: true });
});

app.post('/api/stats', validarKey, (req, res) => {
  res.json({ 
    guilds: client.guilds.cache.size, 
    ping: client.ws.ping, 
    toggles: featureToggles 
  });
});

app.post('/api/get-prompt', validarKey, (req, res) => {
  res.json({ prompt: cargarSystemInstruction() });
});

app.post('/api/save-prompt', validarKey, (req, res) => {
  try {
    const filePath = path.join(__dirname, 'system_instruction.txt');
    fs.writeFileSync(filePath, req.body.prompt, 'utf8');
    logEvent('Instrucciones del sistema actualizadas desde la interfaz web.');
    res.json({ success: true });
  } catch (err) {
    logEvent(`Error guardando las instrucciones: ${err.message}`, true);
    res.status(500).json({ error: 'No se pudo guardar el archivo' });
  }
});

app.post('/api/get-logs', validarKey, (req, res) => {
  res.json({ logs: systemLogs });
});

app.post('/api/force-status', validarKey, async (req, res) => {
  await actualizarEstadoIA();
  res.json({ success: true });
});

app.post('/api/toggle-feature', validarKey, (req, res) => {
  const { feature, value } = req.body;
  if (Object.prototype.hasOwnProperty.call(featureToggles, feature)) {
    featureToggles[feature] = value;
    logEvent(`Estado de la función '${feature}' modificado a: ${value}`);
    res.json({ success: true, toggles: featureToggles });
  } else {
    res.status(400).json({ error: 'La función especificada no existe' });
  }
});

app.post('/api/get-memories', validarKey, async (req, res) => {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl) {
    return res.json({ users: {} });
  }
  try {
    const response = await fetch(`${dbUrl}/usuarios.json`);
    const data = await response.json();
    res.json({ users: data || {} });
  } catch (err) {
    logEvent(`Error al obtener memorias desde Firebase: ${err.message}`, true);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/delete-memory', validarKey, async (req, res) => {
  const { userId, memoryKey } = req.body;
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl) {
    return res.status(400).json({ error: 'Base de datos no configurada' });
  }
  try {
    const targetUrl = `${dbUrl}/usuarios/${userId}/memorias/${memoryKey}.json`;
    await fetch(targetUrl, { method: 'DELETE' });
    logEvent(`Memoria ${memoryKey} eliminada correctamente para el usuario ${userId}`);
    res.json({ success: true });
  } catch (err) {
    logEvent(`Error al eliminar la memoria de Firebase: ${err.message}`, true);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-discord-msg', validarKey, async (req, res) => {
  const { channelId, message } = req.body;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      await channel.send(message);
      logEvent(`Mensaje enviado desde el panel web al canal ${channelId}`);
      return res.json({ success: true });
    }
    res.status(400).json({ error: 'El canal especificado no es de texto o no se encuentra' });
  } catch (err) {
    logEvent(`Error al enviar mensaje a Discord desde la web: ${err.message}`, true);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deep-reset', validarKey, async (req, res) => {
  logEvent('Iniciando proceso de limpieza profunda de RAM y registros...');
  systemLogs = [];
  
  if (global.gc) {
    try { 
      global.gc(); 
      logEvent('Garbage collector ejecutado correctamente.');
    } catch (e) {
      logEvent(`Error al ejecutar Garbage collector: ${e.message}`, true);
    }
  }

  const deployHookUrl = process.env.RENDER_DEPLOY_HOOK_URL;
  if (deployHookUrl) {
    try {
      const response = await fetch(deployHookUrl, { method: 'POST' });
      if (response.ok) {
        logEvent('Solicitud de Re-deploy enviada correctamente a Render.');
        return res.json({ success: true, message: 'Reinicio profundo enviado y despliegue iniciado en Render.' });
      }
    } catch (err) {
      logEvent(`Error activando el Deploy Hook: ${err.message}`, true);
    }
  }

  res.json({ success: true, message: 'Limpieza de RAM completada en el servidor actual.' });
});

app.post('/api/web-chat', async (req, res) => {
  if (!featureToggles.webChat) {
    return res.json({ response: 'El chat web está pausado temporalmente por el administrador.' });
  }
  try {
    const { message, count, imageUrl } = req.body;
    if (count > 15) {
      return res.json({ response: 'Has alcanzado el límite máximo de 15 mensajes de prueba.' });
    }

    let adjuntos = [];
    if (imageUrl) {
      adjuntos.push({ contentType: 'image/png', url: imageUrl });
    }

    const { respuesta, gifBinarios, memeImagenUrl, audioUrl } = await procesarRespuestaIA(
      null, 
      message || 'hola', 
      adjuntos, 
      true, 
      { username: 'UsuarioWeb', id: 'web_guest' }, 
      null
    );

    res.json({ 
      response: respuesta, 
      gifBinarios, 
      memeImagenUrl, 
      audioUrl, 
      remaining: 15 - count 
    });
  } catch (err) {
    logEvent(`Error procesando interacción en el Chat Web: ${err.message}`, true);
    res.status(500).json({ response: 'Ocurrió un error al procesar el mensaje en la web.' });
  }
});

app.listen(PORT, () => {
  logEvent(`Servidor HTTP iniciado y escuchando en el puerto ${PORT}`);
});

// Sistema Auto-Ping para mantener activo el servidor
const RENDER_URL = 'https://klint-gxww.onrender.com';
setInterval(() => {
  fetch(RENDER_URL)
    .then(() => logEvent('Petición de auto-ping realizada con éxito.'))
    .catch((err) => logEvent(`Fallo en la petición de auto-ping: ${err.message}`, true));
}, 10 * 60 * 1000);

// ==========================================
// INICIALIZACIÓN DE CLIENTE DISCORD.JS
// ==========================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

const commands = [
  new SlashCommandBuilder()
    .setName('klint')
    .setDescription('Habla e interactúa directamente con Klint')
    .addStringOption(option =>
      option.setName('pregunta')
        .setDescription('El mensaje o consulta que deseas enviar')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Muestra la ficha técnica, actividad detallada y recuerdos del usuario'),
  new SlashCommandBuilder()
    .setName('ofertas')
    .setDescription('Busca ofertas y descuentos actualizados de juegos'),
  new SlashCommandBuilder()
    .setName('juego')
    .setDescription('Inicia una partida interactiva de Tres en Raya con botones')
].map(command => command.toJSON());

client.once('clientReady', async () => {
  logEvent(`Sesión iniciada exitosamente en Discord como ${client.user.tag}`);
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    logEvent('Comandos Slash (/klint, /status, /ofertas, /juego) registrados y sincronizados.');
  } catch (error) {
    logEvent(`Error al sincronizar comandos Slash en Discord: ${error.message}`, true);
  }

  await actualizarEstadoIA();
  programarCambioEstadoRandom();
});

// ==========================================
// TAREAS Y SERVICIOS EXTERNOS
// ==========================================

/**
 * Tirada aleatoria de temporizador para cambio de estado (Entre 7 y 20 min)
 */
function programarCambioEstadoRandom() {
  const minutosRandom = Math.floor(Math.random() * (20 - 7 + 1)) + 7;
  logEvent(`Temporizador programado: El estado se actualizará en ${minutosRandom} minutos.`);
  
  setTimeout(async () => {
    await actualizarEstadoIA();
    programarCambioEstadoRandom();
  }, minutosRandom * 60 * 1000);
}

/**
 * Consulta la API de CheapShark para obtener juegos en oferta
 * @returns {Promise<string>} Lista formateada de juegos
 */
async function buscarOfertasJuegos() {
  try {
    const res = await fetch('https://www.cheapshark.com/api/1.0/deals?storeID=1&upperPrice=15&pageSize=5');
    if (res.ok) {
      const deals = await res.json();
      const lista = deals.map(d => {
        return `- **${d.title}**: $${d.salePrice} (Precio habitual: $${d.normalPrice}) -> Ahorro: ${Math.round(d.savings)}%`;
      }).join('\n');
      return lista;
    }
  } catch (err) {
    logEvent(`Error consultando la API de CheapShark: ${err.message}`, true);
  }
  return 'No se pudieron recuperar las ofertas en este momento.';
}

/**
 * Descarga GIFs desde la API de Tenor y los convierte en adjuntos binarios
 * @param {string} busqueda - Término de búsqueda
 * @param {number} cantidad - Cantidad deseada
 * @returns {Promise<Array<AttachmentBuilder>>} Lista de adjuntos binarios
 */
async function obtenerGifsBinarios(busqueda, cantidad = 1) {
  if (!featureToggles.gifs) return [];
  
  const limiteMax = Math.min(Math.max(cantidad, 1), 2);
  const termino = busqueda || 'funny meme';
  const attachments = [];

  try {
    const urlTenor = `https://g.tenor.com/v1/search?q=${encodeURIComponent(termino)}&key=LIVDSRZULELA&limit=10`;
    const res = await fetch(urlTenor);
    
    if (res.ok) {
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        for (let i = 0; i < limiteMax && i < data.results.length; i++) {
          const gifUrl = data.results[i].media?.[0]?.gif?.url || data.results[i].url;
          if (gifUrl) {
            const responseGif = await fetch(gifUrl);
            const arrayBuffer = await responseGif.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            attachments.push(new AttachmentBuilder(buffer, { name: `klint_anim_${i+1}.gif` }));
          }
        }
      }
    }
  } catch (err) {
    logEvent(`Error descargando archivos GIF desde Tenor: ${err.message}`, true);
  }

  return attachments;
}

// ==========================================
// INTEGRACIÓN DE MODELOS GEMINI AI
// ==========================================
const MODELOS_FALLBACK = [
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
];

/**
 * Realiza consultas a los endpoints de Gemini con sistema de conmutación por error
 * @param {Array} parts - Partes de texto o multimediales del prompt
 * @param {number} maxTokens - Límite de tokens de salida
 * @returns {Promise<string>} Respuesta obtenida
 */
async function consultarGemini(parts, maxTokens = 150) {
  let ultimoError = null;

  for (const endpoint of MODELOS_FALLBACK) {
    try {
      const url = `${endpoint}?key=${process.env.GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { maxOutputTokens: maxTokens }
        })
      });

      const data = await response.json();
      if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      }
      ultimoError = data.error?.message || `Código de estado: ${response.status}`;
    } catch (err) {
      ultimoError = err.message;
    }
  }

  throw new Error(`Error en los modelos de Gemini: ${ultimoError}`);
}

/**
 * Genera la URL de una imagen de meme basada en plantillas
 * @param {string} textoMeme - Texto del meme
 * @returns {string|null} URL generada
 */
function generarUrlMemeImagen(textoMeme) {
  if (!featureToggles.memes) return null;
  
  try {
    const plantillas = ['doge', 'drake', 'fry', 'buzz', 'fine', 'distracted', 'spenser'];
    const plantillaRandom = plantillas[Math.floor(Math.random() * plantillas.length)];
    
    let textoArriba = 'cuando';
    let textoAbajo = textoMeme;

    if (textoMeme.includes('|')) {
      const partes = textoMeme.split('|');
      textoArriba = partes[0].trim();
      textoAbajo = partes[1].trim();
    }

    const cleanArriba = encodeURIComponent(textoArriba.replace(/[^\w\s]/gi, '').replace(/\s+/g, '_') || 'cuando');
    const cleanAbajo = encodeURIComponent(textoAbajo.replace(/[^\w\s]/gi, '').replace(/\s+/g, '_') || 'pasa_xd');

    return `https://api.memegen.link/images/${plantillaRandom}/${cleanArriba}/${cleanAbajo}.png`;
  } catch (err) {
    logEvent(`Error al construir URL del meme: ${err.message}`, true);
    return null;
  }
}

/**
 * Genera la URL de voz para síntesis de audio nativa
 * @param {string} texto - Texto a convertir en voz
 * @returns {string|null} URL del audio
 */
function obtenerUrlAudioVozNativo(texto) {
  if (!featureToggles.audio) return null;
  
  try {
    const textoLimpio = texto.replace(/<[^>]*>?/gm, '').replace(/[\*\_\`\#\[\]]/g, '').slice(0, 150).trim();
    if (!textoLimpio) return null;
    return `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(textoLimpio)}&tl=es-US&client=tw-ob`;
  } catch (err) {
    logEvent(`Error al generar la URL del sintetizador de voz: ${err.message}`, true);
    return null;
  }
}

// ==========================================
// MÓDULO DE BASE DE DATOS Y MEMORIAS (FIREBASE)
// ==========================================

async function obtenerMemoriaUsuario(userId) {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl || !dbUrl.startsWith('http')) return null;

  try {
    const cleanUrl = dbUrl.endsWith('/') ? dbUrl : `${dbUrl}/`;
    const res = await fetch(`${cleanUrl}usuarios/${userId}.json`);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    logEvent(`Error de lectura en Firebase: ${err.message}`, true);
  }
  return null;
}

async function actualizarPerfilYMemoria(userId, username, displayName, mensaje, resumen) {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl || !dbUrl.startsWith('http')) return;

  try {
    const cleanUrl = dbUrl.endsWith('/') ? dbUrl : `${dbUrl}/`;
    
    await fetch(`${cleanUrl}usuarios/${userId}/perfil.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username,
        displayName: displayName,
        ultimaConexion: new Date().toISOString()
      })
    });

    if (resumen) {
      await fetch(`${cleanUrl}usuarios/${userId}/memorias.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mensaje: mensaje,
          resumen: resumen,
          fecha: new Date().toISOString()
        })
      });
      logEvent(`[Firebase] Nueva memoria registrada para el usuario: ${username}`);
    }
  } catch (err) {
    logEvent(`Error de escritura en Firebase: ${err.message}`, true);
  }
}

async function evaluarYGuardarMemoria(user, mensajeUsuario) {
  try {
    const promptEvaluacion = `Analiza si este mensaje de ${user.username} contiene un dato personal clave, secreto o gusto a recordar a futuro: "${mensajeUsuario}".
Si NO es importante responde: NO.
Si SÍ es importante, responde un resumen super corto de una frase.`;

    const resultado = await consultarGemini([{ text: promptEvaluacion }], 60);
    const textoRespuesta = resultado.trim();

    const resumenParaGuardar = (!textoRespuesta || textoRespuesta.toUpperCase().startsWith('NO')) ? null : textoRespuesta;
    await actualizarPerfilYMemoria(user.id, user.username, user.displayName || user.username, mensajeUsuario, resumenParaGuardar);
  } catch (err) {
    logEvent(`Error durante la evaluación de memoria: ${err.message}`, true);
  }
}

// ==========================================
// ESTADOS Y PRESENCIA DE USUARIOS
// ==========================================

async function actualizarEstadoIA(peticionManual = null) {
  try {
    let promptEstado = 'Inventa un estado de perfil de Discord informal y espontáneo (máximo 5 palabras). Todo en minúsculas, casual, sin puntos ni comillas.';
    if (peticionManual) {
      promptEstado = `Genera un estado de perfil casual basado en esto: "${peticionManual}". Máximo 5 palabras, solo texto.`;
    }

    const textoGenerado = await consultarGemini([{ text: promptEstado }], 25);
    const textoEstado = textoGenerado.trim().replace(/<[^>]*>?/gm, '').replace(/^["']|["']$/g, '').toLowerCase() || 'pensando en la nada';

    client.user.setPresence({
      status: 'online',
      activities: [{
        name: textoEstado,
        type: ActivityType.Custom
      }]
    });
    logEvent(`Estado de presencia actualizado: "${textoEstado}"`);
  } catch (error) {
    logEvent(`Error al actualizar la presencia: ${error.message}`, true);
  }
}

async function obtenerPresenciaDetallada(user, guild = null) {
  let member = null;

  if (guild) {
    try { member = await guild.members.fetch(user.id); } catch (e) {}
  } else {
    for (const g of client.guilds.cache.values()) {
      try {
        member = await g.members.fetch(user.id);
        if (member && member.presence) break;
      } catch (e) {}
    }
  }

  if (!member || !member.presence) return 'Sin actividad visible / Offline';

  const pres = member.presence;
  let detalles = [];

  if (pres.activities && pres.activities.length > 0) {
    pres.activities.forEach(act => {
      if (act.type === 4 || act.type === ActivityType.Custom) {
        if (act.state) detalles.push(`Estado de perfil: "${act.state}"`);
      } else if (act.name === 'Spotify') {
        detalles.push(`Escuchando Spotify: "${act.details}" de ${act.state}`);
      } else if (act.name) {
        detalles.push(`Jugando / Ejecutando: "${act.name}"`);
      }
    });
  }

  return detalles.length > 0 ? detalles.join(' | ') : 'En línea (Sin actividad específica)';
}

// ==========================================
// PROCESAMIENTO CENTRAL DE IA Y CONTEXTO
// ==========================================

async function procesarRespuestaIA(canal, promptUsuario, adjuntos = [], esDM = false, usuarioAutor = null, guild = null) {
  try {
    const systemInstruction = cargarSystemInstruction();
    const presenciaAutor = await obtenerPresenciaDetallada(usuarioAutor, guild);

    let historialFormateado = '';
    let conteoPrevio = 0;

    // Memoria extendida de hasta 20 mensajes previos en el canal
    if (canal) {
      const mensajesPrevios = await canal.messages.fetch({ limit: 20 });
      conteoPrevio = mensajesPrevios.size;
      historialFormateado = mensajesPrevios.reverse().map(m => {
        return `${m.author.username} (<@${m.author.id}>): ${m.content}`;
      }).join('\n');
    }

    let contextoMemoriaAutor = '';
    if (usuarioAutor && usuarioAutor.id !== 'web_guest') {
      const datosFirebase = await obtenerMemoriaUsuario(usuarioAutor.id);
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        contextoMemoriaAutor = `\nRECUERDOS GUARDADOS DE ${usuarioAutor.username}:\n` + memoriasArray.slice(-5).map(m => `- ${m.resumen}`).join('\n');
      }
    }

    // Evento espontáneo aleatorio
    let eventoEspontaneo = '';
    if (Math.random() < 0.01) {
      eventoEspontaneo = "\n[EVENTO ESPECIAL: Comenta espontáneamente sobre revivir la conversación o invitar a jugar si ves alguna app activa.]";
    }

    const promptText = `${systemInstruction}

ENTORNO: ${esDM ? 'CHAT PRIVADO (DM / WEB)' : 'CHAT PÚBLICO'}
ACTIVIDAD DEL USUARIO (${usuarioAutor?.username}): [${presenciaAutor}]
${contextoMemoriaAutor}
${eventoEspontaneo}

HISTORIAL RECIENTE DEL CANAL (20 mensajes):
${historialFormateado}

MENSAJE ACTUAL DE ${usuarioAutor?.username || 'Usuario'}:
${promptUsuario}`;

    const parts = [{ text: promptText }];
    let respuestaRaw = await consultarGemini(parts, 250);
    let respuesta = respuestaRaw.replace(/<[^>]*>?/gm, '').trim();

    let gifBinarios = [];
    let memeImagenUrl = null;
    let audioUrlGenerado = null;

    if (/\b(audio|nota de voz|habla|manda audio)\b/i.test(promptUsuario)) {
      audioUrlGenerado = obtenerUrlAudioVozNativo(respuesta);
    }
    
    if (/\b(meme)\b/i.test(promptUsuario)) {
      memeImagenUrl = generarUrlMemeImagen('cuando pasa | xd');
    }
    
    if (/\b(gif|gifs|dos gifs)\b/i.test(promptUsuario)) {
      const cantidad = /\b(dos|2)\b/i.test(promptUsuario) ? 2 : 1;
      gifBinarios = await obtenerGifsBinarios('funny meme', cantidad);
    }

    if (usuarioAutor && usuarioAutor.id !== 'web_guest') {
      evaluarYGuardarMemoria(usuarioAutor, promptUsuario);
    }

    return { 
      respuesta, 
      gifBinarios, 
      memeImagenUrl, 
      audioUrl: audioUrlGenerado, 
      conteoMensajes: conteoPrevio 
    };
  } catch (err) {
    logEvent(`Error procesando respuesta con IA: ${err.message}`, true);
    return { respuesta: 'me dio un lag xd', gifBinarios: [], memeImagenUrl: null, audioUrl: null, conteoMensajes: 0 };
  }
}

// ==========================================
// EVENTOS E INTERACCIONES DE DISCORD
// ==========================================

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'klint') {
      await interaction.deferReply();
      const pregunta = interaction.options.getString('pregunta');
      const esDM = !interaction.guild;
      
      const { respuesta, gifBinarios, memeImagenUrl, audioUrl } = await procesarRespuestaIA(
        interaction.channel, 
        pregunta, 
        [], 
        esDM, 
        interaction.user, 
        interaction.guild
      );
      
      let files = [...gifBinarios];
      if (memeImagenUrl) files.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
      if (audioUrl) files.push(new AttachmentBuilder(audioUrl, { name: 'audio_klint.mp3' }));
      
      await interaction.editReply({ content: respuesta || 'aquí está', files });
    }

    if (interaction.commandName === 'status') {
      await interaction.deferReply();
      const actividad = await obtenerPresenciaDetallada(interaction.user, interaction.guild);
      const datosFirebase = await obtenerMemoriaUsuario(interaction.user.id);
      
      let memoriasTxt = 'Aún no tengo recuerdos guardados de ti.';
      if (datosFirebase && datosFirebase.memorias) {
        memoriasTxt = Object.values(datosFirebase.memorias).slice(-3).map(m => `- ${m.resumen}`).join('\n');
      }

      const statusMsg = `🤖 **FICHA TÉCNICA Y ACTIVIDAD DE ${interaction.user.username.toUpperCase()}**
🆔 **ID:** \`${interaction.user.id}\`
🎮 **ACTIVIDAD / ESTADO ACTUAL:** ${actividad}

🧠 **LO QUE RECUERDO DE TI:**
${memoriasTxt}`;

      await interaction.editReply({ content: statusMsg });
    }

    if (interaction.commandName === 'ofertas') {
      await interaction.deferReply();
      const ofertasTxt = await buscarOfertasJuegos();
      await interaction.editReply(`🎮 **OFERTAS DESTACADAS EN STEAM:**\n${ofertasTxt}`);
    }

    if (interaction.commandName === 'juego') {
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const row = new ActionRowBuilder();
        for (let j = 0; j < 3; j++) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`tictactoe_${i}_${j}`)
              .setLabel('-')
              .setStyle(ButtonStyle.Secondary)
          );
        }
        rows.push(row);
      }
      await interaction.reply({ content: '❌ **TRES EN RAYA DE KLINT** - Es tu turno (Marcas con X)', components: rows });
    }
  }

  // Listener para botones del minijuego Tres en Raya
  if (interaction.isButton() && interaction.customId.startsWith('tictactoe_')) {
    const partes = interaction.customId.split('_');
    const row = parseInt(partes[1]);
    const col = parseInt(partes[2]);

    const oldRows = interaction.message.components;
    let newRows = [];
    let libres = [];

    for (let r = 0; r < 3; r++) {
      const newRow = new ActionRowBuilder();
      for (let c = 0; c < 3; c++) {
        const btnOld = oldRows[r].components[c];
        let label = btnOld.label;
        let style = btnOld.style;
        let disabled = btnOld.disabled;

        if (r === row && c === col && label === '-') {
          label = 'X';
          style = ButtonStyle.Primary;
          disabled = true;
        }

        if (label === '-') libres.push({ r, c });

        newRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`tictactoe_${r}_${c}`)
            .setLabel(label)
            .setStyle(style)
            .setDisabled(disabled)
        );
      }
      newRows.push(newRow);
    }

    // Turno autónomo de Klint
    if (libres.length > 0) {
      const jugadaKlint = libres[Math.floor(Math.random() * libres.length)];
      newRows[jugadaKlint.r].components[jugadaKlint.c] = new ButtonBuilder()
        .setCustomId(`tictactoe_${jugadaKlint.r}_${jugadaKlint.c}`)
        .setLabel('O')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true);
    }

    await interaction.update({ 
      content: `¡Marcaste posición (${row + 1}, ${col + 1})! Klint respondió con 'O'.`, 
      components: newRows 
    });
  }
});

// Listener de mensajes y detección de voz
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const texto = message.content.toLowerCase();
  
  // Invitación a canal de voz
  if (texto.includes('unete a la llamada') || texto.includes('entra a llamada') || texto.includes('ven a voz')) {
    const voiceChannel = message.member?.voice?.channel;
    if (voiceChannel) {
      await message.reply(`ya voy mano, me ando uniendo al canal de voz **${voiceChannel.name}** xd`);
      return;
    } else {
      await message.reply('entra tú primero a un canal de voz para jalarme pe xd');
      return;
    }
  }

  const patronNombres = /\b(clin|klin|klint|klinty)\b/i;
  const fueMencionado = message.mentions.has(client.user.id);
  const contieneNombre = patronNombres.test(texto);

  if (!message.guild || fueMencionado || contieneNombre) {
    await message.channel.sendTyping();
    
    const { respuesta, gifBinarios, memeImagenUrl, audioUrl } = await procesarRespuestaIA(
      message.channel, 
      message.content, 
      [], 
      !message.guild, 
      message.author, 
      message.guild
    );
    
    let files = [...gifBinarios];
    if (memeImagenUrl) files.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
    if (audioUrl) files.push(new AttachmentBuilder(audioUrl, { name: 'audio_klint.mp3' }));

    // Envío de múltiples mensajes independientes si la IA genera párrafos con salto doble
    const bloquesMensaje = respuesta.split('\n\n').filter(b => b.trim().length > 0);

    if (bloquesMensaje.length > 1) {
      await message.reply({ content: bloquesMensaje[0], files });
      for (let i = 1; i < bloquesMensaje.length; i++) {
        await message.channel.send(bloquesMensaje[i]);
      }
    } else {
      await message.reply({ content: respuesta || 'habla pe', files });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
