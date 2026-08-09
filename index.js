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
const { joinVoiceChannel, getVoiceConnection, VoiceConnectionStatus } = require('@discordjs/voice');
const express = require('express');
const path = require('path');
const fs = require('fs');

// ==========================================
// REGISTRO Y SISTEMA DE LOGS INTERNOS
// ==========================================
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

function cargarSystemInstruction() {
  try {
    const filePath = path.join(__dirname, 'system_instruction.txt');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logEvent(`Error al cargar system_instruction.txt: ${error.message}`, true);
    return 'Eres Klint. Habla casual en minúsculas, respuestas super cortas e informales.';
  }
}

function obtenerFirebaseUrl() {
  let url = process.env.FIREBASE_DATABASE_URL || '';
  const matchMarkdown = url.match(/\((https?:\/\/[^\)]+)\)/);
  if (matchMarkdown) url = matchMarkdown[1];
  url = url.replace(/[\[\]()'"]/g, '').trim();
  if (url && !url.startsWith('http')) url = `https://${url}`;
  return url;
}

// ==========================================
// SERVIDOR WEB Y ENDPOINTS EXPRESS
// ==========================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

function validarKey(req, res, next) {
  const { key } = req.body;
  const claveCorrecta = process.env.saidkey || process.env.SAIDKEY;
  if (key && claveCorrecta && key === claveCorrecta) next();
  else res.status(401).json({ error: 'Clave no autorizada' });
}

app.post('/api/login', validarKey, (req, res) => res.json({ success: true }));

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
    fs.writeFileSync(path.join(__dirname, 'system_instruction.txt'), req.body.prompt, 'utf8');
    logEvent('Instrucciones del sistema actualizadas desde la web.');
    res.json({ success: true });
  } catch (err) {
    logEvent(`Error guardando prompt: ${err.message}`, true);
    res.status(500).json({ error: 'No se pudo guardar el archivo' });
  }
});

app.post('/api/get-logs', validarKey, (req, res) => res.json({ logs: systemLogs }));

app.post('/api/force-status', validarKey, async (req, res) => {
  await actualizarEstadoIA();
  res.json({ success: true });
});

app.post('/api/toggle-feature', validarKey, (req, res) => {
  const { feature, value } = req.body;
  if (Object.prototype.hasOwnProperty.call(featureToggles, feature)) {
    featureToggles[feature] = value;
    logEvent(`Feature '${feature}' cambiado a: ${value}`);
    res.json({ success: true, toggles: featureToggles });
  } else {
    res.status(400).json({ error: 'La función especificada no existe' });
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
    logEvent(`Error leyendo Firebase: ${err.message}`, true);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/delete-memory', validarKey, async (req, res) => {
  const { userId, memoryKey } = req.body;
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl) return res.status(400).json({ error: 'Sin base de datos' });
  try {
    await fetch(`${dbUrl}/usuarios/${userId}/memorias/${memoryKey}.json`, { method: 'DELETE' });
    logEvent(`Memoria ${memoryKey} eliminada del usuario ${userId}`);
    res.json({ success: true });
  } catch (err) {
    logEvent(`Error borrando memoria de Firebase: ${err.message}`, true);
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
    res.status(400).json({ error: 'Canal no encontrado o no es de texto' });
  } catch (err) {
    logEvent(`Error enviando mensaje a Discord: ${err.message}`, true);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/deep-reset', validarKey, async (req, res) => {
  logEvent('Iniciando limpieza profunda...');
  systemLogs = [];
  if (global.gc) {
    try { global.gc(); } catch (e) {}
  }

  const deployHookUrl = process.env.RENDER_DEPLOY_HOOK_URL;
  if (deployHookUrl) {
    try {
      const response = await fetch(deployHookUrl, { method: 'POST' });
      if (response.ok) {
        logEvent('Re-deploy activado en Render.');
        return res.json({ success: true, message: 'Reinicio profundo completado y re-despliegue en curso.' });
      }
    } catch (err) {
      logEvent(`Error invocando Deploy Hook: ${err.message}`, true);
    }
  }

  res.json({ success: true, message: 'Limpieza de RAM completada.' });
});

app.post('/api/web-chat', async (req, res) => {
  if (!featureToggles.webChat) {
    return res.json({ response: 'El chat web está pausado temporalmente.' });
  }
  try {
    const { message, count, imageUrl } = req.body;
    if (count > 15) {
      return res.json({ response: 'Has alcanzado el límite de 15 mensajes de prueba.' });
    }

    let adjuntos = imageUrl ? [{ contentType: 'image/png', url: imageUrl }] : [];
    const { respuesta, gifsUrls, memeImagenUrl, audioUrl } = await procesarRespuestaIA(
      null, message || 'hola', adjuntos, true, { username: 'UsuarioWeb', id: 'web_guest' }, null
    );

    res.json({ response: respuesta, gifsUrls, memeImagenUrl, audioUrl, remaining: 15 - count });
  } catch (err) {
    logEvent(`Error en Web Chat: ${err.message}`, true);
    res.status(500).json({ response: 'Error procesando la solicitud web.' });
  }
});

app.listen(PORT, () => logEvent(`Servidor HTTP activo en puerto ${PORT}`));

// Auto-ping
setInterval(() => {
  fetch('https://klint-gxww.onrender.com')
    .then(() => logEvent('Self-ping exitoso.'))
    .catch((err) => logEvent(`Fallo en self-ping: ${err.message}`, true));
}, 10 * 60 * 1000);

// ==========================================
// CLIENTE DE DISCORD
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
    .setDescription('Habla con Klint')
    .addStringOption(option =>
      option.setName('pregunta')
        .setDescription('Lo que quieres decirle a Klint')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Muestra la ficha técnica, actividad, memorias, meme y GIF de Klint para ti'),
  new SlashCommandBuilder()
    .setName('ofertas')
    .setDescription('Busca ofertas y descuentos actualizados de juegos'),
  new SlashCommandBuilder()
    .setName('juego')
    .setDescription('Inicia una partida de Tres en Raya interactiva con botones')
].map(command => command.toJSON());

client.once('clientReady', async () => {
  logEvent(`Klint ha iniciado sesión como ${client.user.tag}`);
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    logEvent('Comandos Slash /klint, /status, /ofertas y /juego sincronizados.');
  } catch (error) {
    logEvent(`Error al registrar comandos slash: ${error.message}`, true);
  }

  await actualizarEstadoIA();
  programarCambioEstadoRandom();
});

// Temporizador Aleatorio de Estado (7 a 20 Minutos)
function programarCambioEstadoRandom() {
  const minutosRandom = Math.floor(Math.random() * (20 - 7 + 1)) + 7;
  logEvent(`Dado de estado tirado: Siguiente cambio en ${minutosRandom} minutos.`);
  
  setTimeout(async () => {
    await actualizarEstadoIA();
    programarCambioEstadoRandom();
  }, minutosRandom * 60 * 1000);
}

// Búsqueda de GIFs Reales mediante Tenor API
async function buscarGifsReales(busqueda, cantidad = 1) {
  if (!featureToggles.gifs) return [];
  
  const limiteMax = Math.min(Math.max(cantidad, 1), 2);
  const termino = busqueda || 'funny meme';
  const urlsEncontradas = [];

  try {
    const urlTenor = `https://g.tenor.com/v1/search?q=${encodeURIComponent(termino)}&key=LIVDSRZULELA&limit=10`;
    const res = await fetch(urlTenor);
    
    if (res.ok) {
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        for (let i = 0; i < limiteMax && i < data.results.length; i++) {
          const gifDirecto = data.results[i].media?.[0]?.gif?.url || data.results[i].url;
          if (gifDirecto) urlsEncontradas.push(gifDirecto);
        }
        if (urlsEncontradas.length > 0) return urlsEncontradas;
      }
    }
  } catch (err) {
    logEvent(`Error al consultar Tenor API: ${err.message}`, true);
  }

  return ['https://media.tenor.com/yhe9to9A4E8AAAAC/cat-cat-typing.gif'];
}

// Ofertas de Juegos
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
  return 'No encontré ofertas en este momento mano xd';
}

// ==========================================
// MODELOS GEMINI AI
// ==========================================
const MODELOS_FALLBACK = [
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
];

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
      ultimoError = data.error?.message || `Status ${response.status}`;
    } catch (err) {
      ultimoError = err.message;
    }
  }

  throw new Error(`Error en API Gemini: ${ultimoError}`);
}

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
    logEvent(`Error formando URL de meme: ${err.message}`, true);
    return null;
  }
}

function obtenerUrlAudioVozNativo(texto) {
  if (!featureToggles.audio) return null;
  try {
    const textoLimpio = texto.replace(/<[^>]*>?/gm, '').replace(/[\*\_\`\#\[\]]/g, '').slice(0, 150).trim();
    if (!textoLimpio) return null;
    return `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(textoLimpio)}&tl=es-US&client=tw-ob`;
  } catch (err) {
    logEvent(`Error generando audio nativo: ${err.message}`, true);
    return null;
  }
}

// ==========================================
// FIREBASE MEMORIA PERSISTENTE
// ==========================================
async function obtenerMemoriaUsuario(userId) {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl || !dbUrl.startsWith('http')) return null;

  try {
    const cleanUrl = dbUrl.endsWith('/') ? dbUrl : `${dbUrl}/`;
    const res = await fetch(`${cleanUrl}usuarios/${userId}.json`);
    if (res.ok) return await res.json();
  } catch (err) {
    logEvent(`Error al conectar con Firebase: ${err.message}`, true);
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
      logEvent(`[Firebase] Memoria guardada para ${username}`);
    }
  } catch (err) {
    logEvent(`Error guardando en Firebase: ${err.message}`, true);
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
    logEvent(`Error evaluando memoria: ${err.message}`, true);
  }
}

// ==========================================
// PRESENCIA Y DETECCIÓN EN DISCORD
// ==========================================
async function actualizarEstadoIA(peticionManual = null) {
  try {
    let promptEstado = 'Inventa un estado de perfil de Discord informal y espontáneo (máximo 5 palabras). Todo en minúsculas, casual, sin puntos ni comillas.';
    if (peticionManual) {
      promptEstado = `Genera un estado de perfil casual basado en esto: "${peticionManual}". Máximo 5 palabras, solo texto.`;
    }

    const textoGenerado = await consultarGemini([{ text: promptEstado }], 25);
    const textoEstado = textoGenerado.trim().replace(/<[^>]*>?/gm, '').replace(/^["']|["']$/g, '').toLowerCase() || 'pensando en la nada';

    const estadosVisibilidad = ['online', 'idle', 'dnd'];
    const estadoAleatorio = estadosVisibilidad[Math.floor(Math.random() * estadosVisibilidad.length)];

    client.user.setPresence({
      status: estadoAleatorio,
      activities: [{
        name: textoEstado,
        type: ActivityType.Custom
      }]
    });
    logEvent(`Estado Personalizado actualizado: "${textoEstado}" (${estadoAleatorio})`);
  } catch (error) {
    logEvent(`Error actualizando presencia: ${error.message}`, true);
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
        detalles.push(`Escuchando en Spotify: "${act.details}" de ${act.state}`);
      } else if (act.name) {
        detalles.push(`Jugando / Usando App: "${act.name}"`);
      }
    });
  }

  return detalles.length > 0 ? detalles.join(' | ') : 'En línea (Sin actividad específica)';
}

async function obtenerDetallesIntegrantesServidor(guild) {
  if (!guild) return 'Entorno DM (Sin lista masiva de servidor)';
  try {
    const miembros = await guild.members.fetch();
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

      resumenMiembros.push(`- ${m.user.username} (Tag: <@${m.id}>) ${esBot} [Perfil: "${estadoTexto}"${actividadTexto}]`);
    });

    return resumenMiembros.slice(0, 25).join('\n');
  } catch (err) {
    logEvent(`Error obteniendo integrantes del servidor: ${err.message}`, true);
    return 'No se pudo sincronizar la lista de miembros';
  }
}

// ==========================================
// PROCESAR RESPUESTA IA CENTRAL
// ==========================================
async function procesarRespuestaIA(canal, promptUsuario, adjuntos = [], esDM = false, usuarioAutor = null, guild = null) {
  try {
    const systemInstruction = cargarSystemInstruction();
    
    const presenciaAutor = await obtenerPresenciaDetallada(usuarioAutor, guild);
    const miembrosServidorTexto = await obtenerDetallesIntegrantesServidor(guild);

    let historialFormateado = '';
    let conteoPrevio = 0;

    // Memoria extendida de hasta 20 mensajes de contexto
    if (canal) {
      const mensajesPrevios = await canal.messages.fetch({ limit: 20 });
      conteoPrevio = mensajesPrevios.size;
      historialFormateado = mensajesPrevios.reverse().map(m => {
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

    let contextoMemoriaAutor = '';
    if (usuarioAutor && usuarioAutor.id !== 'web_guest') {
      const datosFirebase = await obtenerMemoriaUsuario(usuarioAutor.id);
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        contextoMemoriaAutor = `\nRECUERDOS DE ${usuarioAutor.username}:\n` + memoriasArray.slice(-5).map(m => `- ${m.resumen}`).join('\n');
      }
    }

    const tipoEntorno = esDM ? 'CHAT PRIVADO (DM / WEB)' : 'CHAT PÚBLICO';

    const pideGifExplicitamente = /\b(gif|manda un gif|pasa un gif|envia un gif|gifs|dos gifs)\b/i.test(promptUsuario);
    const pideMemeImagen = /\b(crea un meme|haz un meme|generar meme|meme en imagen)\b/i.test(promptUsuario);
    const pideAudio = /\b(manda un audio|manda audio|nota de voz|habla|dilo en audio|audio|mensje de voz|mensaje voz)\b/i.test(promptUsuario);

    let instruccionExtra = '';
    if (pideAudio) {
      instruccionExtra = "\nREGLA DE AUDIO: Escribe ÚNICAMENTE la frase corta que vas a decir en voz alta.";
    } else if (pideMemeImagen) {
      instruccionExtra = "\nREGLA DE MEME EN IMAGEN: Crea un meme corto en dos líneas usando el tag [GENERAR_MEME: texto arriba | texto abajo]. NUNCA escribas el tag en el texto visible del mensaje.";
    } else if (pideGifExplicitamente) {
      instruccionExtra = "\nREGLA DE GIF: Agrega [BUSCAR_GIF: palabra_clave_en_ingles]. NUNCA escribas el tag en el texto visible del mensaje. Máximo 2.";
    }

    // Evento raro espontáneo (1% de probabilidad)
    let eventoEspontaneo = '';
    if (Math.random() < 0.01) {
      eventoEspontaneo = "\n[EVENTO RARO: Comenta espontáneamente para revivir la conversación o invitar a usar una app activa.]";
    }

    const promptText = `${systemInstruction}

ENTORNO: ${tipoEntorno}
DATOS DEL USUARIO QUE TE HABLA (${usuarioAutor?.username}): [${presenciaAutor}]
${instruccionExtra}
${contextoMemoriaAutor}
${eventoEspontaneo}

LISTA DE MIEMBROS DE ESTE SERVIDOR:
${miembrosServidorTexto}

HISTORIAL DEL CHAT (Últimos 20 mensajes):
${historialFormateado}

MENSAJE DE ${usuarioAutor?.username || 'Usuario'} A RESPONDER:
${promptUsuario}`;

    const parts = [{ text: promptText }];

    let respuestaRaw = await consultarGemini(parts, 200);
    let respuesta = respuestaRaw.replace(/<[^>]*>?/gm, '').trim();

    let gifsUrlsEncontradas = [];
    let memeImagenUrl = null;
    let audioUrlGenerado = null;

    if (pideAudio) {
      audioUrlGenerado = obtenerUrlAudioVozNativo(respuesta);
    } 
    
    // Extracción limpia de tag de meme sin fuga de texto
    const matchMeme = respuesta.match(/\[GENERAR_MEME:\s*([^\]]+)\]/i);
    if (matchMeme || pideMemeImagen) {
      const textoMeme = matchMeme ? matchMeme[1].trim() : 'cuando pasa | xd';
      respuesta = respuesta.replace(/\[GENERAR_MEME:\s*([^\]]+)\]/gi, '').trim();
      memeImagenUrl = generarUrlMemeImagen(textoMeme);
    }

    // Extracción limpia de tag de GIF sin fuga de texto
    const matchGif = respuesta.match(/\[BUSCAR_GIF:\s*([^\]]+)\]/i);
    if (matchGif || pideGifExplicitamente) {
      const terminoBusqueda = matchGif ? matchGif[1].trim() : promptUsuario;
      respuesta = respuesta.replace(/\[BUSCAR_GIF:\s*([^\]]+)\]/gi, '').trim();
      
      const cantidadPedida = /\b(dos|2|un par)\b/i.test(promptUsuario) ? 2 : 1;
      gifsUrlsEncontradas = await buscarGifsReales(terminoBusqueda, cantidadPedida);
    }

    if (usuarioAutor && usuarioAutor.id !== 'web_guest') {
      evaluarYGuardarMemoria(usuarioAutor, promptUsuario);
    }

    return { 
      respuesta: respuesta || 'aquí tienes', 
      gifsUrls: gifsUrlsEncontradas, 
      memeImagenUrl, 
      audioUrl: audioUrlGenerado, 
      conteoMensajes: conteoPrevio 
    };
  } catch (error) {
    logEvent(`Error en procesarRespuestaIA: ${error.message}`, true);
    return { respuesta: 'me dio un lag xd', gifsUrls: [], memeImagenUrl: null, audioUrl: null, conteoMensajes: 0 };
  }
}

// ==========================================
// SLASH COMMANDS & INTERACCIONES
// ==========================================
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'klint') {
      await interaction.deferReply();
      const pregunta = interaction.options.getString('pregunta');
      const esDM = !interaction.guild;
      const { respuesta, gifsUrls, memeImagenUrl, audioUrl } = await procesarRespuestaIA(interaction.channel, pregunta, [], esDM, interaction.user, interaction.guild);
      
      let archivosAdjuntos = [];
      if (memeImagenUrl) archivosAdjuntos.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
      if (audioUrl) archivosAdjuntos.push(new AttachmentBuilder(audioUrl, { name: 'audio_klint.mp3' }));

      let mensajeFinal = respuesta;
      if (gifsUrls.length > 0) {
        mensajeFinal = `${respuesta}\n${gifsUrls.join('\n')}`.trim();
      }

      await interaction.editReply({ content: mensajeFinal || 'aquí está', files: archivosAdjuntos });
    }

    if (interaction.commandName === 'status') {
      await interaction.deferReply();
      
      const user = interaction.user;
      const member = interaction.member;
      const nick = member?.displayName || user.username;
      const username = user.username;

      const actividad = await obtenerPresenciaDetallada(user, interaction.guild);
      const datosFirebase = await obtenerMemoriaUsuario(user.id);
      
      let resumenMemoria = 'Aún no tengo datos guardados sobre ti.';
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        resumenMemoria = memoriasArray.slice(-3).map(m => `- ${m.resumen}`).join('\n');
      }

      const memeTexto = `cuando ${nick} usa /status | y klint ya se acuerda de todo xd`;
      const memeUrl = generarUrlMemeImagen(memeTexto);
      const gifsUrls = await buscarGifsReales('cool robot', 1);

      let archivosAdjuntos = [];
      if (memeUrl) archivosAdjuntos.push(new AttachmentBuilder(memeUrl, { name: 'status_meme.png' }));

      const mensajeStatus = `🤖 **FICHA TÉCNICA DE KLINT - ESTADO ACTUAL**
👤 **Usuario:** ${username} (Apodo: ${nick})
🆔 **ID:** \`${user.id}\`
🎮 **ACTIVIDAD ACTUAL:** ${actividad}

🧠 **LO QUE RECUERDO DE TI:**
${resumenMemoria}

⚡ **CAPACIDADES ACTIVAS:**
1. 🎙️ **Notas de voz MP3:** Pídeme "manda un audio".
2. 🖼️ **Generador de Memes:** Pídeme "haz un meme".
3. 🎞️ **GIFs en vivo:** Pídeme "manda un gif".
4. 👀 **Presencia en Tiempo Real:** Detección de juegos y Spotify.
5. 💬 **Memoria Persistente:** Guardado automático en Firebase.

${gifsUrls.join('\n')}`;

      await interaction.editReply({ content: mensajeStatus, files: archivosAdjuntos });
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
              .setDisabled(false)
          );
        }
        rows.push(row);
      }
      await interaction.reply({ content: '❌ **TRES EN RAYA DE KLINT** - Es tu turno (Marcas con X)', components: rows });
    }
  }

  // LÓGICA DE TRES EN RAYA FUNCIONAL Y SIN BLOQUEOS
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

    // Turno inteligente de Klint (Marca O)
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

// ==========================================
// MENSAJES Y CONEXIÓN A VOZ
// ==========================================
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  try {
    const esDM = !message.guild;
    const textoLower = message.content.toLowerCase();

    // Detección y Conexión a Canal de Voz
    if (textoLower.includes('unete a la llamada') || textoLower.includes('entra a llamada') || textoLower.includes('ven a voz')) {
      const voiceChannel = message.member?.voice?.channel;
      if (voiceChannel) {
        try {
          joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          });
          await message.reply(`ya me uní al canal de voz **${voiceChannel.name}** mano xd`);
          return;
        } catch (err) {
          logEvent(`Error al unirse al canal de voz: ${err.message}`, true);
          await message.reply('intente unirme pero dio un error el canal de voz pe xd');
          return;
        }
      } else {
        await message.reply('entra tú primero a un canal de voz para jalarme pe xd');
        return;
      }
    }
    
    const patronNombres = /\b(clin|klin|klint|klinty)\b/i;
    const fueMencionadoDirectamente = message.mentions.has(client.user.id);
    const contieneNombre = patronNombres.test(textoLower);
    const tieneAdjuntos = message.attachments.size > 0;
    const tieneStickers = message.stickers.size > 0;

    if (contieneNombre && (textoLower.includes('cambia tu estado') || textoLower.includes('ponte de estado'))) {
      await message.channel.sendTyping();
      await actualizarEstadoIA(message.content);
      
      if (esDM) await message.channel.send('ya lo cambié xd');
      else await message.reply('ya lo cambié xd');
      return;
    }

    if (esDM || fueMencionadoDirectamente || contieneNombre || (tieneAdjuntos && contieneNombre) || (tieneStickers && contieneNombre)) {
      await message.channel.sendTyping();
      
      const adjuntosArray = Array.from(message.attachments.values());
      const { respuesta, gifsUrls, memeImagenUrl, audioUrl, conteoMensajes } = await procesarRespuestaIA(message.channel, message.content, adjuntosArray, esDM, message.author, message.guild);
      
      let archivosAdjuntos = [];
      if (memeImagenUrl) archivosAdjuntos.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
      if (audioUrl) archivosAdjuntos.push(new AttachmentBuilder(audioUrl, { name: 'audio_klint.mp3' }));

      let textoFinal = respuesta;
      if (gifsUrls.length > 0) {
        textoFinal = `${respuesta}\n${gifsUrls.join('\n')}`.trim();
      }

      // División de párrafos en mensajes independientes si se requiere
      const bloquesMensaje = textoFinal.split('\n\n').filter(b => b.trim().length > 0);

      if (bloquesMensaje.length > 1) {
        // Primer mensaje respondiendo directamente (linked)
        await message.reply({ content: bloquesMensaje[0], files: archivosAdjuntos });
        
        // Mensajes restantes enviados en el canal (unlinked)
        for (let i = 1; i < bloquesMensaje.length; i++) {
          await message.channel.send({ content: bloquesMensaje[i] });
        }
      } else {
        const contenidoMensaje = textoFinal || (archivosAdjuntos.length > 0 ? 'aquí tienes' : 'xd');
        if (esDM || conteoMensajes <= 3) {
          await message.channel.send({ content: contenidoMensaje, files: archivosAdjuntos });
        } else {
          await message.reply({ content: contenidoMensaje, files: archivosAdjuntos });
        }
      }
    }
  } catch (err) {
    logEvent(`Error enviando mensaje a Discord: ${err.message}`, true);
  }
});

client.login(process.env.DISCORD_TOKEN);
