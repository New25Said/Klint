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

function logEvent(msg, esError = false) {
  const timestamp = new Date().toLocaleTimeString();
  const prefijo = esError ? '[ERROR âŒ]' : '[INFO â„¹ï¸]';
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
  logEvent(`ExcepciÃ³n no capturada detectada: ${err.stack || err.message}`, true);
});

// ==========================================
// CONFIGURACIÃ“N Y TOGGLES EN TIEMPO REAL
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
    return 'Eres Klint. Habla casual en minÃºsculas, respuestas super cortas e informales.';
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
    res.status(400).json({ error: 'La funciÃ³n especificada no existe' });
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
    return res.json({ response: 'El chat web estÃ¡ pausado temporalmente.' });
  }
  try {
    const { message, count, imageUrl } = req.body;
    if (count > 15) {
      return res.json({ response: 'Has alcanzado el lÃ­mite de 15 mensajes de prueba.' });
    }

    let adjuntos = imageUrl ? [{ contentType: 'image/png', url: imageUrl }] : [];
    const { respuesta, gifBinario, memeImagenUrl, audioUrl } = await procesarRespuestaIA(
      null, message || 'hola', adjuntos, true, { username: 'UsuarioWeb', id: 'web_guest' }, null
    );

    res.json({ response: respuesta, gifBinario, memeImagenUrl, audioUrl, remaining: 15 - count });
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
    .setDescription('Muestra el panel completo de diagnostico, memorias, actividad en vivo e historial'),
  new SlashCommandBuilder()
    .setName('ofertas')
    .setDescription('Busca ofertas y descuentos actualizados de juegos'),
  new SlashCommandBuilder()
    .setName('juego')
    .setDescription('Inicia una partida de Tres en Raya interactiva con botones')
].map(command => command.toJSON());

client.once('clientReady', async () => {
  logEvent(`Klint ha iniciado sesiÃ³n como ${client.user.tag}`);
  
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

// ==========================================
// BUSCADOR DE GIFS CON FALLBACKS Y BINARIOS
// ==========================================
const GIFS_FALLBACK = [
  'https://media.tenor.com/yhe9to9A4E8AAAAC/cat-cat-typing.gif',
  'https://media.tenor.com/gKIn4D2o8p4AAAAC/funny-cat.gif',
  'https://media.tenor.com/2roX357_640AAAAC/meme-cat.gif',
  'https://media.tenor.com/vH1_fB6M3eIAAAAC/cat-meme.gif'
];

async function obtenerGifBinario(busqueda) {
  if (!featureToggles.gifs) return null;
  const termino = busqueda || 'funny cat';

  try {
    const urlTenor = `https://g.tenor.com/v1/search?q=${encodeURIComponent(termino)}&key=LIVDSRZULELA&limit=5`;
    const res = await fetch(urlTenor);
    
    if (res.ok) {
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        const gifUrl = data.results[0].media?.[0]?.gif?.url || data.results[0].url;
        if (gifUrl) {
          const resGif = await fetch(gifUrl);
          const arrayBuffer = await resGif.arrayBuffer();
          logEvent(`[OK GIF: Tenor API] Obtenido GIF para "${termino}"`);
          return new AttachmentBuilder(Buffer.from(arrayBuffer), { name: 'klint_gif.gif' });
        }
      }
    }
    logEvent(`[FALLBACK GIF: Servidor Secundario] Tenor no devolviÃ³ resultados directos para "${termino}"`, true);
  } catch (err) {
    logEvent(`[FALLBACK GIF: Error Red] FallÃ³ la bÃºsqueda de GIF: ${err.message}`, true);
  }

  // Fallback seguro local
  try {
    const fallbackUrl = GIFS_FALLBACK[Math.floor(Math.random() * GIFS_FALLBACK.length)];
    const resFb = await fetch(fallbackUrl);
    const bufferFb = await resFb.arrayBuffer();
    logEvent('[FALLBACK GIF: Descargado desde CDN de Reserva]');
    return new AttachmentBuilder(Buffer.from(bufferFb), { name: 'klint_fallback.gif' });
  } catch (e) {
    logEvent(`[FALLBACK GIF CRÃTICO: FallÃ³ CDN local]: ${e.message}`, true);
    return null;
  }
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
  return 'No encontrÃ© ofertas en este momento mano xd';
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

  for (let i = 0; i < MODELOS_FALLBACK.length; i++) {
    const endpoint = MODELOS_FALLBACK[i];
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
        if (i > 0) logEvent(`[FALLBACK GEMINI: Nivel ${i}] Respondido usando modelo secundario`);
        return data.candidates[0].content.parts[0].text;
      }
      ultimoError = data.error?.message || `Status ${response.status}`;
    } catch (err) {
      ultimoError = err.message;
    }
  }

  throw new Error(`Error en API Gemini: ${ultimoError}`);
}

// VARIADED AMPLIADA DE PLANTILLAS DE MEMES
function generarUrlMemeImagen(textoMeme) {
  if (!featureToggles.memes) return null;
  try {
    const plantillas = [
      'doge', 'drake', 'fry', 'buzz', 'fine', 'distracted', 'spenser',
      'cryingfloor', 'disastergirl', 'facepalm', 'pawn-stars', 'success', 'twobuttons'
    ];
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

    logEvent(`[OK MEME: Generado con plantilla ${plantillaRandom}]`);
    return `https://api.memegen.link/images/${plantillaRandom}/${cleanArriba}/${cleanAbajo}.png`;
  } catch (err) {
    logEvent(`[FALLBACK MEME: Error en motor de imÃ¡genes] ${err.message}`, true);
    return null;
  }
}

// SÃNTESIS DE VOZ CON FALLBACKS
function obtenerUrlAudioVozNativo(texto) {
  if (!featureToggles.audio) return null;
  try {
    const textoLimpio = texto.replace(/<[^>]*>?/gm, '').replace(/[\*\_\`\#\[\]]/g, '').slice(0, 150).trim();
    if (!textoLimpio) return null;
    
    logEvent('[OK AUDIO: StreamElements TTS Motor 1]');
    return `https://api.streamelements.com/kappa/v2/speech?voice=Mia&text=${encodeURIComponent(textoLimpio)}`;
  } catch (err) {
    logEvent(`[FALLBACK AUDIO: Google TTS Secundario] ${err.message}`, true);
    return `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(texto)}&tl=es-US&client=tw-ob`;
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
Si SÃ es importante, responde un resumen super corto de una frase.`;

    const resultado = await consultarGemini([{ text: promptEvaluacion }], 60);
    const textoRespuesta = resultado.trim();

    const resumenParaGuardar = (!textoRespuesta || textoRespuesta.toUpperCase().startsWith('NO')) ? null : textoRespuesta;
    await actualizarPerfilYMemoria(user.id, user.username, user.displayName || user.username, mensajeUsuario, resumenParaGuardar);
  } catch (err) {
    logEvent(`Error evaluando memoria: ${err.message}`, true);
  }
}

// ==========================================
// PRESENCIA Y DETECCIÃ“N EN DISCORD
// ==========================================
async function actualizarEstadoIA(peticionManual = null) {
  try {
    let promptEstado = 'Inventa un estado de perfil de Discord informal y espontÃ¡neo (mÃ¡ximo 5 palabras). Todo en minÃºsculas, casual, sin puntos ni comillas.';
    if (peticionManual) {
      promptEstado = `Genera un estado de perfil casual basado en esto: "${peticionManual}". MÃ¡ximo 5 palabras, solo texto.`;
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

  if (!member || !member.presence) return 'ConexiÃ³n: Offline / Invisible';

  const pres = member.presence;
  const statusMap = { online: 'ðŸŸ¢ En lÃ­nea', idle: 'ðŸŒ™ Ausente', dnd: 'ðŸ”´ No molestar', offline: 'âšª Desconectado' };
  const estadoConexion = statusMap[pres.status] || 'ðŸŸ¢ En lÃ­nea';

  let detalles = [`Estado: ${estadoConexion}`];

  if (pres.activities && pres.activities.length > 0) {
    pres.activities.forEach(act => {
      if (act.type === 4 || act.type === ActivityType.Custom) {
        if (act.state) detalles.push(`Perfil: "${act.state}"`);
      } else if (act.name === 'Spotify') {
        detalles.push(`Escuchando en Spotify: "${act.details}" de ${act.state}`);
      } else if (act.name) {
        detalles.push(`Jugando: "${act.name}"`);
      }
    });
  }

  return detalles.join(' | ');
}

// ==========================================
// PROCESAR RESPUESTA IA CENTRAL CON VISIÃ“N MULTIMODAL
// ==========================================
async function procesarRespuestaIA(canal, promptUsuario, adjuntos = [], esDM = false, usuarioAutor = null, guild = null) {
  try {
    const systemInstruction = cargarSystemInstruction();
    const presenciaAutor = await obtenerPresenciaDetallada(usuarioAutor, guild);

    let historialFormateado = '';
    let conteoPrevio = 0;

    if (canal) {
      const mensajesPrevios = await canal.messages.fetch({ limit: 20 });
      conteoPrevio = mensajesPrevios.size;
      historialFormateado = mensajesPrevios.reverse().map(m => {
        let extra = '';
        if (m.attachments.size > 0) extra += ` [EnviÃ³ archivo/imagen: ${m.attachments.first().url}]`;
        if (m.stickers.size > 0) extra += ` [EnviÃ³ sticker: ${m.stickers.first().name}]`;
        return `${m.author.username} (<@${m.author.id}>): ${m.content}${extra}`;
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

    const pideGifExplicitamente = /\b(gif|manda un gif|pasa un gif|envia un gif)\b/i.test(promptUsuario);
    const pideMemeImagen = /\b(crea un meme|haz un meme|generar meme|meme en imagen)\b/i.test(promptUsuario);
    const pideAudio = /\b(manda un audio|manda audio|nota de voz|habla|dilo en audio|audio)\b/i.test(promptUsuario);
    const esInvitacionLlamada = /discord\.(gg|com\/invite)|unete|entra a la llamada|ven a voz/i.test(promptUsuario);

    let instruccionExtra = '';
    if (esInvitacionLlamada) {
      instruccionExtra = "\nREGLA DE INVITACIÃ“N: Detectaste que el usuario te invita o envÃ­a un enlace/llamada de voz. Agradece la invitaciÃ³n con tono casual y explica que prefieres el chat o quÃ© canal estÃ¡s viendo.";
    } else if (pideAudio) {
      instruccionExtra = "\nREGLA DE AUDIO: Escribe ÃšNICAMENTE la frase corta que vas a decir en voz alta.";
    } else if (pideMemeImagen) {
      instruccionExtra = "\nREGLA DE MEME EN IMAGEN: Usa el tag [GENERAR_MEME: texto arriba | texto abajo]. NUNCA escribas el tag en el texto visible del mensaje.";
    } else if (pideGifExplicitamente) {
      instruccionExtra = "\nREGLA DE GIF: Usa [BUSCAR_GIF: palabra_clave_en_ingles]. NUNCA escribas el tag en el texto visible.";
    }

    const promptText = `${systemInstruction}

ENTORNO: ${esDM ? 'CHAT PRIVADO (DM / WEB)' : 'CHAT PÃšBLICO'}
DATOS Y ESTADO DEL USUARIO (${usuarioAutor?.username}): [${presenciaAutor}]
${instruccionExtra}
${contextoMemoriaAutor}

HISTORIAL RECIENTE DEL CANAL (20 mensajes):
${historialFormateado}

MENSAJE ACTUAL DE ${usuarioAutor?.username || 'Usuario'}:
${promptUsuario}`;

    // ConstrucciÃ³n de partes con soporte para imÃ¡genes multimediales
    const parts = [{ text: promptText }];

    for (const adj of adjuntos) {
      if (adj.contentType && adj.contentType.startsWith('image/')) {
        parts.push({
          inlineData: {
            mimeType: adj.contentType,
            data: Buffer.from(await (await fetch(adj.url)).arrayBuffer()).toString('base64')
          }
        });
      }
    }

    let respuestaRaw = await consultarGemini(parts, 200);
    let respuesta = respuestaRaw.replace(/<[^>]*>?/gm, '').trim();

    let gifBinario = null;
    let memeImagenUrl = null;
    let audioUrlGenerado = null;

    if (pideAudio) {
      audioUrlGenerado = obtenerUrlAudioVozNativo(respuesta);
    } 
    
    const matchMeme = respuesta.match(/\[GENERAR_MEME:\s*([^\]]+)\]/i);
    if (matchMeme || pideMemeImagen) {
      const textoMeme = matchMeme ? matchMeme[1].trim() : 'cuando pasa | xd';
      respuesta = respuesta.replace(/\[GENERAR_MEME:\s*([^\]]+)\]/gi, '').trim();
      memeImagenUrl = generarUrlMemeImagen(textoMeme);
    }

    const matchGif = respuesta.match(/\[BUSCAR_GIF:\s*([^\]]+)\]/i);
    if (matchGif || pideGifExplicitamente) {
      const terminoBusqueda = matchGif ? matchGif[1].trim() : promptUsuario;
      respuesta = respuesta.replace(/\[BUSCAR_GIF:\s*([^\]]+)\]/gi, '').trim();
      gifBinario = await obtenerGifBinario(terminoBusqueda);
    }

    if (usuarioAutor && usuarioAutor.id !== 'web_guest') {
      evaluarYGuardarMemoria(usuarioAutor, promptUsuario);
    }

    return { 
      respuesta: respuesta || 'aquÃ­ tienes', 
      gifBinario, 
      memeImagenUrl, 
      audioUrl: audioUrlGenerado, 
      conteoMensajes: conteoPrevio 
    };
  } catch (error) {
    logEvent(`Error en procesarRespuestaIA: ${error.message}`, true);
    return { respuesta: 'me dio un lag xd', gifBinario: null, memeImagenUrl: null, audioUrl: null, conteoMensajes: 0 };
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
      const { respuesta, gifBinario, memeImagenUrl, audioUrl } = await procesarRespuestaIA(interaction.channel, pregunta, [], esDM, interaction.user, interaction.guild);
      
      let archivosAdjuntos = [];
      if (memeImagenUrl) archivosAdjuntos.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
      if (audioUrl) archivosAdjuntos.push(new AttachmentBuilder(audioUrl, { name: 'audio_klint.mp3' }));
      if (gifBinario) archivosAdjuntos.push(gifBinario);

      await interaction.editReply({ content: respuesta || 'aquÃ­ estÃ¡', files: archivosAdjuntos });
    }

    if (interaction.commandName === 'status') {
      await interaction.deferReply();
      
      const user = interaction.user;
      const member = interaction.member;
      const nick = member?.displayName || user.username;

      const presenciaDetallada = await obtenerPresenciaDetallada(user, interaction.guild);
      const datosFirebase = await obtenerMemoriaUsuario(user.id);
      
      let resumenMemoria = 'AÃºn no tengo datos guardados sobre ti.';
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        resumenMemoria = memoriasArray.map(m => `- ${m.resumen}`).join('\n');
      }

      const ramUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
      const uptimeMin = Math.floor(process.uptime() / 60);

      const memeTexto = `cuando ${nick} revisa /status | y klint tiene todo en orden xd`;
      const memeUrl = generarUrlMemeImagen(memeTexto);
      const gifBinario = await obtenerGifBinario('cool robot');

      let archivosAdjuntos = [];
      if (memeUrl) archivosAdjuntos.push(new AttachmentBuilder(memeUrl, { name: 'status_meme.png' }));
      if (gifBinario) archivosAdjuntos.push(gifBinario);

      const mensajeStatus = `ðŸ“Š **DIAGNÃ“STICO Y FICHA EN VIVO DE KLINT**
ðŸ‘¤ **Usuario:** ${user.username} (Apodo: ${nick})
ðŸ†” **ID:** \`${user.id}\`
ðŸŽ® **ESTADO EN VIVO Y ACTIVIDAD:**
${presenciaDetallada}

âš™ï¸ **MÃ‰TRICAS DEL HOST:**
- ðŸŸ¢ Servidores: ${client.guilds.cache.size}
- âš¡ Ping Websocket: ${client.ws.ping} ms
- ðŸ’¾ Uso RAM: ${ramUsage} MB
- â±ï¸ Uptime: ${uptimeMin} minutos

ðŸ§  **RECUERDOS REGISTRADOS EN FIREBASE:**
${resumenMemoria}

ðŸ› ï¸ **ESTADO DE MÃ“DULOS:**
- ðŸŽ™ï¸ Voz MP3: **${featureToggles.audio ? 'ON âœ…' : 'OFF âŒ'}**
- ðŸ–¼ï¸ Memes: **${featureToggles.memes ? 'ON âœ…' : 'OFF âŒ'}**
- ðŸŽžï¸ GIFs Binarios: **${featureToggles.gifs ? 'ON âœ…' : 'OFF âŒ'}**
- ðŸ’¬ Chat Web API: **${featureToggles.webChat ? 'ON âœ…' : 'OFF âŒ'}**`;

      await interaction.editReply({ content: mensajeStatus, files: archivosAdjuntos });
    }

    if (interaction.commandName === 'ofertas') {
      await interaction.deferReply();
      const ofertasTxt = await buscarOfertasJuegos();
      await interaction.editReply(`ðŸŽ® **OFERTAS DESTACADAS EN STEAM:**\n${ofertasTxt}`);
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
      await interaction.reply({ content: 'âŒ **TRES EN RAYA DE KLINT** - Es tu turno (Marcas con X)', components: rows });
    }
  }

  // LÃ“GICA DE TRES EN RAYA
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

    if (libres.length > 0) {
      const jugadaKlint = libres[Math.floor(Math.random() * libres.length)];
      newRows[jugadaKlint.r].components[jugadaKlint.c] = new ButtonBuilder()
        .setCustomId(`tictactoe_${jugadaKlint.r}_${jugadaKlint.c}`)
        .setLabel('O')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true);
    }

    await interaction.update({ 
      content: `Â¡Marcaste posiciÃ³n (${row + 1}, ${col + 1})! Klint respondiÃ³ con 'O'.`, 
      components: newRows 
    });
  }
});

// ==========================================
// MENSAJES Y RESPUESTAS
// ==========================================
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  try {
    const esDM = !message.guild;
    const textoLower = message.content.toLowerCase();
    
    const patronNombres = /\b(clin|klin|klint|klinty)\b/i;
    const fueMencionadoDirectamente = message.mentions.has(client.user.id);
    const contieneNombre = patronNombres.test(textoLower);
    const tieneAdjuntos = message.attachments.size > 0;
    const tieneStickers = message.stickers.size > 0;

    if (contieneNombre && (textoLower.includes('cambia tu estado') || textoLower.includes('ponte de estado'))) {
      await message.channel.sendTyping();
      await actualizarEstadoIA(message.content);
      
      if (esDM) await message.channel.send('ya lo cambiÃ© xd');
      else await message.reply('ya lo cambiÃ© xd');
      return;
    }

    if (esDM || fueMencionadoDirectamente || contieneNombre || tieneAdjuntos || tieneStickers) {
      await message.channel.sendTyping();
      
      const adjuntosArray = Array.from(message.attachments.values());
      const { respuesta, gifBinario, memeImagenUrl, audioUrl, conteoMensajes } = await procesarRespuestaIA(message.channel, message.content, adjuntosArray, esDM, message.author, message.guild);
      
      let archivosAdjuntos = [];
      if (memeImagenUrl) archivosAdjuntos.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
      if (audioUrl) archivosAdjuntos.push(new AttachmentBuilder(audioUrl, { name: 'audio_klint.mp3' }));
      if (gifBinario) archivosAdjuntos.push(gifBinario);

      const bloquesMensaje = respuesta.split('\n\n').filter(b => b.trim().length > 0);

      if (bloquesMensaje.length > 1) {
        await message.reply({ content: bloquesMensaje[0], files: archivosAdjuntos });
        for (let i = 1; i < bloquesMensaje.length; i++) {
          await message.channel.send({ content: bloquesMensaje[i] });
        }
      } else {
        const contenidoMensaje = respuesta || (archivosAdjuntos.length > 0 ? 'aquÃ­ tienes' : 'xd');
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
