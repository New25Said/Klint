const { 
  Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder, 
  AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle 
} = require('discord.js');
const express = require('express');
const path = require('path');
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

// Control en tiempo real desde la Web
const featureToggles = {
  audio: true,
  memes: true,
  gifs: true,
  webChat: true
};

process.on('unhandledRejection', (reason) => logEvent(`Promesa no manejada: ${reason?.stack || reason}`, true));
process.on('uncaughtException', (err) => logEvent(`Excepción no capturada: ${err.stack || err.message}`, true));

// Instanciación del Cliente Discord
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

// Cargar system_instruction.txt
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
  return url.replace(/\/+$/, '');
}

// Servidor Express
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function validarKey(req, res, next) {
  const { key } = req.body;
  const claveCorrecta = process.env.saidkey || process.env.SAIDKEY;
  if (key && claveCorrecta && key === claveCorrecta) next();
  else res.status(401).json({ error: 'Clave no autorizada' });
}

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
  
  if (global.gc) {
    try { global.gc(); } catch (e) {}
  }

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

app.post('/api/web-chat', async (req, res) => {
  if (!featureToggles.webChat) {
    return res.json({ response: 'el chat web está pausado temporalmente por el admin xd' });
  }
  try {
    const { message, count, imageUrl } = req.body;
    if (count > 15) {
      return res.json({ response: 'alcanzaste el límite de 15 mensajes de prueba pe mano xd' });
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
    res.status(500).json({ response: 'me dio un lag xd' });
  }
});

app.listen(PORT, () => logEvent(`Servidor HTTP activo en puerto ${PORT}`));

// Auto-ping
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
    .setDescription('Inicia una partida de Tres en Raya con botones')
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
  iniciarMonitoreoRevivirChat();
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
  return 'No encontré ofertas en este momento mano xd';
}

// Modelos Oficiales Activos Gemini API v1beta
const MODELOS_FALLBACK = [
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'
];

async function consultarGemini(parts, maxTokens = 120) {
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

// Búsqueda de GIFs estrictamente MÁXIMO 1
async function buscarGifsReales(busqueda) {
  if (!featureToggles.gifs) return [];
  const termino = busqueda || 'funny meme';
  const urlsEncontradas = [];

  const giphyKey = process.env.GIPHY_API_KEY;
  if (giphyKey) {
    try {
      const urlGiphy = `https://api.giphy.com/v1/gifs/search?api_key=${giphyKey}&q=${encodeURIComponent(termino)}&limit=1&rating=g`;
      const resGiphy = await fetch(urlGiphy);
      if (resGiphy.ok) {
        const dataGiphy = await resGiphy.json();
        if (dataGiphy.data && dataGiphy.data.length > 0) {
          const gifUrl = dataGiphy.data[0].images?.original?.url || dataGiphy.data[0].images?.downsized_medium?.url;
          if (gifUrl) urlsEncontradas.push(gifUrl);
          return urlsEncontradas;
        }
      }
    } catch (err) {
      logEvent(`Error al consultar Giphy API: ${err.message}`, true);
    }
  }

  try {
    const urlTenor = `https://g.tenor.com/v1/search?q=${encodeURIComponent(termino)}&key=LIVDSRZULELA&limit=1`;
    const res = await fetch(urlTenor);
    if (res.ok) {
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        const gifDirecto = data.results[0].media?.[0]?.gif?.url || data.results[0].url;
        if (gifDirecto) urlsEncontradas.push(gifDirecto);
        return urlsEncontradas;
      }
    }
  } catch (err) {
    logEvent(`Error al consultar Tenor API: ${err.message}`, true);
  }

  return ['https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExdWZ4OHl0ZG9zcHNmd3NwcjExMjl2MmVlZnVpM2VydjBjcmsxMG90ZSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3o7abKhOpu0NwenH3O/giphy.gif'];
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

    const cleanArriba = sanearTexto(textoArriba);
    const cleanAbajo = sanearTexto(textoAbajo);

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

    if (client.user) {
      client.user.setPresence({
        status: estadoAleatorio,
        activities: [{
          name: textoEstado,
          type: ActivityType.Custom
        }]
      });
    }
    logEvent(`Estado Personalizado actualizado: "${textoEstado}" (${estadoAleatorio})`);
  } catch (error) {
    logEvent(`Error actualizando presencia: ${error.message}`, true);
  }
}

// Dado de cambio de estado entre 5 y 15 minutos
function programarCambioEstadoRandom() {
  const minutosRandom = Math.floor(Math.random() * (15 - 5 + 1)) + 5;
  setTimeout(async () => {
    await actualizarEstadoIA();
    programarCambioEstadoRandom();
  }, minutosRandom * 60 * 1000);
}

// Monitoreo para Revivir Chat Inactivo (2 Horas de silencio)
function iniciarMonitoreoRevivirChat() {
  setInterval(async () => {
    if (!client.isReady()) return;

    for (const guild of client.guilds.cache.values()) {
      try {
        const textChannels = guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
        for (const channel of textChannels.values()) {
          const messages = await channel.messages.fetch({ limit: 1 });
          const lastMsg = messages.first();
          if (lastMsg) {
            const horasInactivo = (Date.now() - lastMsg.createdTimestamp) / (1000 * 60 * 60);
            if (horasInactivo >= 2) {
              const promptRevivir = "El chat ha estado callado por horas. Di una sola frase muy corta y casual en minúsculas para revivir el chat o preguntar qué hacen.";
              const frase = await consultarGemini([{ text: promptRevivir }], 40);
              await channel.send(frase.toLowerCase().trim());
              logEvent(`Chat revivido en el canal ${channel.name} de ${guild.name}`);
              break;
            }
          }
        }
      } catch (err) {
        logEvent(`Error verificando inactividad de chat: ${err.message}`, true);
      }
    }
  }, 30 * 60 * 1000); // Revisa cada 30 min
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

function obtenerDetallesIntegrantesServidorOptimizado(guild) {
  if (!guild) return 'Entorno DM (Sin lista masiva de servidor)';
  try {
    const miembros = guild.members.cache;
    const resumenMiembros = [];

    miembros.forEach(m => {
      const esBot = m.user.bot ? '[BOT]' : '[USUARIO]';
      resumenMiembros.push(`- ${m.user.username} (Tag: <@${m.id}>) ${esBot}`);
    });

    return resumenMiembros.slice(0, 20).join('\n');
  } catch (err) {
    return 'Miembros del servidor cargados en caché local.';
  }
}

// Procesar respuesta de la IA
async function procesarRespuestaIA(canal, promptUsuario, adjuntos = [], esDM = false, usuarioAutor = null, guild = null) {
  try {
    const systemInstruction = cargarSystemInstruction();
    const miembrosServidorTexto = obtenerDetallesIntegrantesServidorOptimizado(guild);

    let historialFormateado = '';
    let conteoPrevio = 0;

    if (canal) {
      const mensajesPrevios = await canal.messages.fetch({ limit: 5 });
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
        const ultimasMemorias = memoriasArray.slice(-3).map(m => `- ${m.resumen}`).join('\n');
        contextoMemoriaAutor = `\nRECUERDOS DE ${usuarioAutor.username}:\n${ultimasMemorias}\n`;
      }
    }

    const tipoEntorno = esDM ? 'CHAT PRIVADO (DM / WEB)' : 'CHAT PÚBLICO';

    const pideGifExplicitamente = /\b(gif|manda un gif|pasa un gif|envia un gif|gifs)\b/i.test(promptUsuario);
    const pideMemeImagen = /\b(crea un meme|haz un meme|generar meme|meme en imagen)\b/i.test(promptUsuario);
    const pideAudio = /\b(manda un audio|manda audio|nota de voz|habla|dilo en audio|audio|mensje de voz|mensaje de voz|mensaje voz)\b/i.test(promptUsuario);

    let instruccionExtra = '';
    if (pideAudio) {
      instruccionExtra = "\nREGLA DE AUDIO: Escribe ÚNICAMENTE la frase corta que vas a decir en voz alta.";
    } else if (pideMemeImagen) {
      instruccionExtra = "\nREGLA DE MEME EN IMAGEN: Crea un meme corto en dos líneas usando el tag [GENERAR_MEME: texto arriba | texto abajo]. NUNCA escribas el tag en el texto visible del mensaje.";
    } else if (pideGifExplicitamente) {
      instruccionExtra = "\nREGLA DE GIF: Agrega al final [BUSCAR_GIF: palabra_clave_en_ingles]. NUNCA escribas el tag en el texto visible del mensaje. Se enviará únicamente 1 GIF.";
    }

    const promptText = `${systemInstruction}

ENTORNO: ${tipoEntorno}
${instruccionExtra}
${contextoMemoriaAutor}

LISTA DE MIEMBROS DE ESTE SERVIDOR:
${miembrosServidorTexto}

HISTORIAL DEL CHAT:
${historialFormateado}

MENSAJE DE ${usuarioAutor?.username || 'Usuario'} A RESPONDER:
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

    let respuestaRaw = await consultarGemini(parts, 120);
    let respuesta = respuestaRaw.replace(/<[^>]*>?/gm, '').trim();

    let gifsUrlsEncontradas = [];
    let memeImagenUrl = null;
    let audioUrlGenerado = null;

    if (pideAudio) {
      audioUrlGenerado = obtenerUrlAudioVozNativo(respuesta);
    } else if (pideMemeImagen || respuesta.includes('[GENERAR_MEME:')) {
      const matchMeme = respuesta.match(/\[GENERAR_MEME:\s*([^\]]+)\]/i);
      const textoMeme = matchMeme ? matchMeme[1] : 'cuando pasa | xd';
      respuesta = respuesta.replace(/\[GENERAR_MEME:\s*([^\]]+)\]/i, '').trim();
      memeImagenUrl = generarUrlMemeImagen(textoMeme);
    }

    const matchGif = respuesta.match(/\[BUSCAR_GIF:\s*([^\]]+)\]/i);
    if (matchGif || pideGifExplicitamente) {
      let terminoBusqueda = matchGif ? matchGif[1].trim() : promptUsuario.replace(/\b(manda|pasa|envia|un|gif|gifs|de)\b/gi, '').trim();
      if (!terminoBusqueda) terminoBusqueda = 'funny meme';
      gifsUrlsEncontradas = await buscarGifsReales(terminoBusqueda);
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

// Helper para construir tablero del Tres en Raya (Fijados símbolos visibles válidos)
function construirTableroTicTacToe(tablero) {
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const row = new ActionRowBuilder();
    for (let j = 0; j < 3; j++) {
      const idx = i * 3 + j;
      const valor = tablero[idx];
      const btn = new ButtonBuilder()
        .setCustomId(`tictactoe_${i}_${j}`)
        .setLabel(valor === '-' ? '➖' : valor)
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

// Slash Commands e Interacciones
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
      await interaction.editReply({ content: mensajeFinal || 'aquí está', files: archivosAdjuntos });

      // Si Klint requiere enviar el GIF o contenido extra por separado
      if (gifsUrls.length > 0) {
        await interaction.followUp({ content: gifsUrls[0] });
      }
    }

    if (interaction.commandName === 'status') {
      await interaction.deferReply();
      
      const user = interaction.user;
      const member = interaction.member;
      const nick = member?.displayName || user.username;
      const username = user.username;

      const datosFirebase = await obtenerMemoriaUsuario(user.id);
      let resumenMemoria = 'Aún no tengo datos guardados sobre ti.';
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        resumenMemoria = memoriasArray.slice(-3).map(m => `- ${m.resumen}`).join('\n');
      }

      const memeTexto = `cuando ${nick} usa /status | y klint ya se acuerda de todo xd`;
      const memeUrl = generarUrlMemeImagen(memeTexto);
      const gifsUrls = await buscarGifsReales('cool robot');

      const archivosAdjuntos = [];
      if (memeUrl) archivosAdjuntos.push(new AttachmentBuilder(memeUrl, { name: 'status_meme.png' }));

      const mensajeStatus = `🤖 **FICHA TÉCNICA DE KLINT - ESTADO ACTUAL**
👤 **Usuario:** ${username} (Apodo: ${nick})
🆔 **ID:** \`${user.id}\`

🧠 **MEMORIA GUARDADA SOBRE TI:**
${resumenMemoria}

⚡ **CAPACIDADES ACTIVAS DE KLINT:**
1. 🎙️ **Notas de voz:** Pídeme "manda un audio" y te responderé en MP3.
2. 🖼️ **Generador de Memes e Imágenes:** Pídeme "haz un meme" y crearé una imagen personalizada.
3. 🎞️ **GIFs en vivo:** Pídeme "manda un gif" para recibir un GIF animado real.
4. 👀 **Presencia en Tiempo Real:** Reviso actividad del servidor sin saturar Gateway.
5. 💬 **Memoria Persistente:** Recuerdo tus gustos y conversaciones en Firebase.`;

      await interaction.editReply({ content: mensajeStatus, files: archivosAdjuntos });

      if (gifsUrls.length > 0) {
        await interaction.followUp({ content: gifsUrls[0] });
      }
    }

    if (interaction.commandName === 'ofertas') {
      await interaction.deferReply();
      const ofertasTxt = await buscarOfertasJuegos();
      await interaction.editReply(`🎮 **OFERTAS DESTACADAS DE JUEGOS:**\n${ofertasTxt}`);
    }

    if (interaction.commandName === 'juego') {
      const tableroInicial = Array(9).fill('-');
      const rows = construirTableroTicTacToe(tableroInicial);
      await interaction.reply({ content: '❌ **TRES EN RAYA DE KLINT** - Haz tu primer movimiento:', components: rows });
    }
  }

  // Manejo interactivo de botones para Tres en Raya
  if (interaction.isButton() && interaction.customId.startsWith('tictactoe_')) {
    const message = interaction.message;
    const parts = interaction.customId.split('_');
    const r = parseInt(parts[1]);
    const c = parseInt(parts[2]);
    const idxClick = r * 3 + c;

    let board = [];
    message.components.forEach(row => {
      row.components.forEach(btn => {
        const label = btn.label.trim();
        if (label === '❌') board.push('❌');
        else if (label === '⭕') board.push('⭕');
        else board.push('-');
      });
    });

    if (board[idxClick] !== '-') {
      return interaction.reply({ content: 'Esa casilla ya está ocupada pe mano.', ephemeral: true });
    }

    board[idxClick] = '❌';

    let ganador = verificarGanadorTicTacToe(board);
    if (ganador) {
      const statusText = ganador === '❌' ? '🎉 ¡Me ganaste mano! Bien jugado.' : '🤝 ¡Empate!';
      return interaction.update({ content: `❌ **TRES EN RAYA DE KLINT** - ${statusText}`, components: construirTableroTicTacToe(board) });
    }

    const casillasLibres = board.map((v, i) => v === '-' ? i : null).filter(v => v !== null);
    if (casillasLibres.length > 0) {
      const eleccionKlint = casillasLibres[Math.floor(Math.random() * casillasLibres.length)];
      board[eleccionKlint] = '⭕';
    }

    ganador = verificarGanadorTicTacToe(board);
    let textoResultado = 'Tu turno pe:';
    if (ganador === '⭕') textoResultado = '🤖 ¡Gané yo xd! Más suerte para la próxima.';
    else if (ganador === 'EMPATE') textoResultado = '🤝 ¡Empate!';

    await interaction.update({ content: `❌ **TRES EN RAYA DE KLINT** - ${textoResultado}`, components: construirTableroTicTacToe(board) });
  }
});

// Mensajes Directos y Servidores
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
      
      if (esDM) {
        await message.channel.send('ya lo cambié xd');
      } else {
        await message.reply('ya lo cambié xd');
      }
      return;
    }

    if (esDM || fueMencionadoDirectamente || contieneNombre || (tieneAdjuntos && contieneNombre) || (tieneStickers && contieneNombre)) {
      await message.channel.sendTyping();
      
      const adjuntosArray = Array.from(message.attachments.values());
      const { respuesta, gifsUrls, memeImagenUrl, audioUrl, conteoMensajes } = await procesarRespuestaIA(message.channel, message.content, adjuntosArray, esDM, message.author, message.guild);
      
      let archivosAdjuntos = [];
      if (memeImagenUrl) archivosAdjuntos.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
      if (audioUrl) archivosAdjuntos.push(new AttachmentBuilder(audioUrl, { name: 'audio_klint.mp3' }));

      const textoLimpio = respuesta.length > 2000 ? respuesta.slice(0, 1995) + '...' : respuesta;
      const contenidoMensaje = textoLimpio || (archivosAdjuntos.length > 0 ? 'aquí tienes' : 'xd');

      // Primer Envío principal
      if (esDM || conteoMensajes <= 3) {
        await message.channel.send({ content: contenidoMensaje, files: archivosAdjuntos });
      } else {
        await message.reply({ content: contenidoMensaje, files: archivosAdjuntos });
      }

      // Segundo mensaje en caso de requerir enviar GIF por separado o enlace dinámico
      if (gifsUrls.length > 0) {
        await message.channel.send(gifsUrls[0]);
      }
    }
  } catch (err) {
    logEvent(`Error enviando mensaje a Discord: ${err.message}`, true);
  }
});

client.login(process.env.DISCORD_TOKEN);
