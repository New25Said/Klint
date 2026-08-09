const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const express = require('express');
const path = require('path');
const fs = require('fs');
const googleTTS = require('google-tts-api');

// Logs del sistema para el Dashboard Web
const systemLogs = [];
function logEvent(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${msg}`;
  console.log(entry);
  systemLogs.unshift(entry);
  if (systemLogs.length > 30) systemLogs.pop();
}

// Carga de instrucciones de personalidad
function cargarSystemInstruction() {
  try {
    const filePath = path.join(__dirname, 'system_instruction.txt');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logEvent('Error al cargar system_instruction.txt');
    return 'Eres Klint. Habla casual en minúsculas, respuestas super cortas e informales.';
  }
}

// Extrae la URL limpia de Firebase
function obtenerFirebaseUrl() {
  let url = process.env.FIREBASE_DATABASE_URL || '';
  const matchMarkdown = url.match(/\((https?:\/\/[^\)]+)\)/);
  if (matchMarkdown) url = matchMarkdown[1];
  url = url.replace(/[\[\]()'"]/g, '').trim();
  if (url && !url.startsWith('http')) url = `https://${url}`;
  return url;
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
app.post('/api/stats', validarKey, (req, res) => res.json({ guilds: client.guilds.cache.size, ping: client.ws.ping }));
app.post('/api/get-prompt', validarKey, (req, res) => res.json({ prompt: cargarSystemInstruction() }));
app.post('/api/save-prompt', validarKey, (req, res) => {
  try {
    fs.writeFileSync(path.join(__dirname, 'system_instruction.txt'), req.body.prompt, 'utf8');
    logEvent('Instrucciones actualizadas.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo guardar' });
  }
});
app.post('/api/get-logs', validarKey, (req, res) => res.json({ logs: systemLogs }));
app.post('/api/force-status', validarKey, async (req, res) => {
  await actualizarEstadoIA();
  res.json({ success: true });
});

app.listen(PORT, () => logEvent(`Servidor HTTP activo en puerto ${PORT}`));

// Auto-ping
const RENDER_URL = 'https://klint-gxww.onrender.com';
setInterval(() => {
  fetch(RENDER_URL)
    .then(() => logEvent('Self-ping exitoso para mantener Klint activo.'))
    .catch((err) => console.error('Error en self-ping:', err));
}, 10 * 60 * 1000);

// Client de Discord
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

const commands = [
  new SlashCommandBuilder()
    .setName('klint')
    .setDescription('Habla con Klint')
    .addStringOption(option =>
      option.setName('pregunta')
        .setDescription('Lo que quieres decirle a Klint')
        .setRequired(true)
    )
].map(command => command.toJSON());

client.once('clientReady', async () => {
  logEvent(`Klint ha iniciado sesión como ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    logEvent('Comandos /klint registrados correctamente.');
  } catch (error) {
    logEvent(`Error al registrar comandos slash: ${error.message}`);
  }

  await actualizarEstadoIA();
  programarCambioEstadoRandom();
});

// Modelos Gemini
const MODELOS_FALLBACK = [
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
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

  throw new Error(`Error en API: ${ultimoError}`);
}

// Búsqueda de GIF real en Tenor
async function buscarGifRealTenor(busqueda) {
  try {
    const apiKey = 'LIVDSRZULELA';
    const url = `https://g.tenor.com/v1/search?q=${encodeURIComponent(busqueda)}&key=${apiKey}&limit=5`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        const itemRandom = data.results[Math.floor(Math.random() * data.results.length)];
        return itemRandom.itemurl || itemRandom.url;
      }
    }
  } catch (err) {
    logEvent(`Error buscando GIF en Tenor: ${err.message}`);
  }
  return null;
}

// Generador de Memes en Imagen Real (Memegen.link API)
function generarUrlMemeImagen(textoMeme) {
  const plantillas = ['doge', 'drake', 'catmeme', 'pigeon', 'grim', 'cryingwillis'];
  const plantillaRandom = plantillas[Math.floor(Math.random() * plantillas.length)];
  const textoLimpio = encodeURIComponent(textoMeme.replace(/\s+/g, '_').toLowerCase() || 'meme_casual');
  return `https://api.memegen.link/images/${plantillaRandom}/_/${textoLimpio}.png`;
}

// Generador de Audios sintetizados en MP3 con acento latino/peruano
function obtenerUrlAudioVoz(texto) {
  try {
    const textoLimpio = texto.replace(/[\*\_\`\#]/g, '').slice(0, 180);
    return googleTTS.getAudioUrl(textoLimpio, {
      lang: 'es-US',
      slow: false,
      host: 'https://translate.google.com',
      timeout: 10000,
    });
  } catch (err) {
    logEvent(`Error generando audio TTS: ${err.message}`);
    return null;
  }
}

// REST API para Firebase
async function obtenerMemoriaUsuario(userId) {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl || !dbUrl.startsWith('http')) return null;

  try {
    const cleanUrl = dbUrl.endsWith('/') ? dbUrl : `${dbUrl}/`;
    const res = await fetch(`${cleanUrl}usuarios/${userId}.json`);
    if (res.ok) return await res.json();
  } catch (err) {
    logEvent(`Error leyendo Firebase: ${err.message}`);
  }
  return null;
}

async function obtenerTodosLosUsuariosConocidos() {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl || !dbUrl.startsWith('http')) return [];

  try {
    const cleanUrl = dbUrl.endsWith('/') ? dbUrl : `${dbUrl}/`;
    const res = await fetch(`${cleanUrl}usuarios.json`);
    if (res.ok) {
      const data = await res.json();
      if (!data) return [];
      
      const listaComunidad = [];
      for (const [id, info] of Object.entries(data)) {
        if (info.perfil) {
          let ultimasMemorias = '';
          if (info.memorias) {
            ultimasMemorias = Object.values(info.memorias).slice(-2).map(m => m.resumen).join('; ');
          }
          listaComunidad.push(`- ${info.perfil.username} (<@${id}>): ${ultimasMemorias || 'Miembro del chat'}`);
        }
      }
      return listaComunidad;
    }
  } catch (err) {
    logEvent(`Error obteniendo personas conocidas: ${err.message}`);
  }
  return [];
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
      logEvent(`[Firebase] Nueva memoria guardada para ${username}`);
    }
  } catch (err) {
    logEvent(`Error actualizando Firebase: ${err.message}`);
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
    logEvent(`Error evaluando memoria: ${err.message}`);
  }
}

// ESTADO PERSONALIZADO ÚNICO Y TRADICIONAL
async function actualizarEstadoIA(peticionManual = null) {
  try {
    let promptEstado = 'Inventa un estado de perfil de Discord informal y espontáneo (máximo 5 palabras). Todo en minúsculas, casual, sin puntos ni comillas.';
    if (peticionManual) {
      promptEstado = `Genera un estado de perfil casual basado en esto: "${peticionManual}". Máximo 5 palabras, solo texto.`;
    }

    const textoGenerado = await consultarGemini([{ text: promptEstado }], 25);
    const textoEstado = textoGenerado.trim().replace(/^["']|["']$/g, '').toLowerCase() || 'pensando en la nada';

    const estadosVisibilidad = ['online', 'idle', 'dnd'];
    const estadoAleatorio = estadosVisibilidad[Math.floor(Math.random() * estadosVisibilidad.length)];

    client.user.setPresence({
      status: estadoAleatorio,
      activities: [{
        name: textoEstado,
        type: ActivityType.Custom
      }]
    });
    logEvent(`Estado Personalizado cambiado a: "${textoEstado}" (${estadoAleatorio})`);
  } catch (error) {
    logEvent(`Error al generar estado personalizado: ${error.message}`);
  }
}

function programarCambioEstadoRandom() {
  const minutosRandom = Math.floor(Math.random() * (35 - 7 + 1)) + 7;
  setTimeout(async () => {
    await actualizarEstadoIA();
    programarCambioEstadoRandom();
  }, minutosRandom * 60 * 1000);
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
    return null;
  }
}

async function obtenerPresenciaCualquierEntorno(user, guild = null) {
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
    return 'No se pudo sincronizar la lista de miembros';
  }
}

// Procesar respuesta de la IA
async function procesarRespuestaIA(canal, promptUsuario, adjuntos = [], esDM = false, usuarioAutor = null, guild = null) {
  try {
    const systemInstruction = cargarSystemInstruction();
    
    const presenciaAutor = await obtenerPresenciaCualquierEntorno(usuarioAutor, guild);
    const miembrosServidorTexto = await obtenerDetallesIntegrantesServidor(guild);

    const mensajesPrevios = await canal.messages.fetch({ limit: 5 });
    const historialFormateado = mensajesPrevios.reverse().map(m => {
      const usuarioNombre = m.author.username;
      const usuarioId = m.author.id;
      let contenido = m.content;

      if (m.stickers && m.stickers.size > 0) {
        const nombresStickers = m.stickers.map(s => `[Sticker enviado: ${s.name}]`).join(' ');
        contenido = `${contenido} ${nombresStickers}`.trim();
      }

      return `${usuarioNombre} (<@${usuarioId}>): ${contenido}`;
    }).join('\n');

    let contextoMemoriaAutor = '';
    if (usuarioAutor) {
      const datosFirebase = await obtenerMemoriaUsuario(usuarioAutor.id);
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        const ultimasMemorias = memoriasArray.slice(-3).map(m => `- ${m.resumen}`).join('\n');
        contextoMemoriaAutor = `\nRECUERDOS DE ${usuarioAutor.username}:\n${ultimasMemorias}\n`;
      }
    }

    const tipoEntorno = esDM ? 'CHAT PRIVADO (DM)' : 'CHAT PÚBLICO';

    const pideGifExplicitamente = /\b(gif|meme|imagen|manda un gif|pasa un gif|envia un gif)\b/i.test(promptUsuario);
    const pideMemeImagen = /\b(crea un meme|haz un meme|generar meme|meme en imagen)\b/i.test(promptUsuario);
    const pideAudio = /\b(manda un audio|manda audio|nota de voz|habla|dilo en audio|audio|mensje de voz|mensaje de voz)\b/i.test(promptUsuario);

    let instruccionExtra = '';
    if (pideAudio) {
      instruccionExtra = "\nREGLA DE AUDIO: El usuario te pidió responder en audio. Escribe una respuesta corta y casual para ser sintetizada en voz.";
    } else if (pideMemeImagen) {
      instruccionExtra = "\nREGLA DE MEME EN IMAGEN: El usuario te pidió un meme en imagen. Agrega al final [GENERAR_MEME: texto_del_meme].";
    } else if (pideGifExplicitamente) {
      instruccionExtra = "\nREGLA DE GIF: El usuario te pidió un GIF. Agrega al final [BUSCAR_GIF: tema_del_gif].";
    }

    const promptText = `${systemInstruction}

ENTORNO: ${tipoEntorno}
DATOS DEL USUARIO QUE TE HABLA (${usuarioAutor?.username}): [${presenciaAutor}]
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

    let respuesta = await consultarGemini(parts, 120);

    let gifUrlEncontrada = null;
    let memeImagenUrl = null;
    let audioUrlGenerado = null;

    if (pideAudio) {
      audioUrlGenerado = obtenerUrlAudioVoz(respuesta);
    } else if (pideMemeImagen || respuesta.includes('[GENERAR_MEME:')) {
      const matchMeme = respuesta.match(/\[GENERAR_MEME:\s*([^\]]+)\]/i);
      const textoMeme = matchMeme ? matchMeme[1] : 'cuando pasa xd';
      respuesta = respuesta.replace(/\[GENERAR_MEME:\s*([^\]]+)\]/i, '').trim();
      memeImagenUrl = generarUrlMemeImagen(textoMeme);
    } else {
      if (pideGifExplicitamente && !respuesta.includes('[BUSCAR_GIF:')) {
        const palabras = promptUsuario.replace(/manda|pasa|envia|un|gif|meme|klint|clin/gi, '').trim();
        const busquedaAuto = palabras.length > 2 ? palabras : 'random meme';
        respuesta += ` [BUSCAR_GIF: ${busquedaAuto}]`;
      }

      const matchGif = respuesta.match(/\[BUSCAR_GIF:\s*([^\]]+)\]/i);
      if (matchGif) {
        const terminoBusqueda = matchGif[1].trim();
        respuesta = respuesta.replace(/\[BUSCAR_GIF:\s*([^\]]+)\]/i, '').trim();
        gifUrlEncontrada = await buscarGifRealTenor(terminoBusqueda);
      }
    }

    if (usuarioAutor) {
      evaluarYGuardarMemoria(usuarioAutor, promptUsuario);
    }

    return { 
      respuesta, 
      gifUrl: gifUrlEncontrada, 
      memeImagenUrl, 
      audioUrl: audioUrlGenerado, 
      conteoMensajes: mensajesPrevios.size 
    };
  } catch (error) {
    logEvent(`Error en procesarRespuestaIA: ${error.message}`);
    return { respuesta: 'me dio un lag xd', gifUrl: null, memeImagenUrl: null, audioUrl: null, conteoMensajes: 0 };
  }
}

// Slash Commands (/klint)
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'klint') {
    await interaction.deferReply();
    const pregunta = interaction.options.getString('pregunta');
    const esDM = !interaction.guild;
    const { respuesta, gifUrl, memeImagenUrl, audioUrl } = await procesarRespuestaIA(interaction.channel, pregunta, [], esDM, interaction.user, interaction.guild);
    
    let archivosAdjuntos = [];
    if (memeImagenUrl) archivosAdjuntos.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
    if (audioUrl) archivosAdjuntos.push(new AttachmentBuilder(audioUrl, { name: 'audio_klint.mp3' }));

    let mensajeFinal = respuesta;
    if (gifUrl) mensajeFinal = `${respuesta}\n${gifUrl}`.trim();

    await interaction.editReply({ content: mensajeFinal, files: archivosAdjuntos });
  }
});

// Mensajes Directos y Servidores
client.on('messageCreate', async message => {
  if (message.author.bot) return;

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
    const { respuesta, gifUrl, memeImagenUrl, audioUrl, conteoMensajes } = await procesarRespuestaIA(message.channel, message.content, adjuntosArray, esDM, message.author, message.guild);
    
    let archivosAdjuntos = [];
    if (memeImagenUrl) archivosAdjuntos.push(new AttachmentBuilder(memeImagenUrl, { name: 'meme_klint.png' }));
    if (audioUrl) archivosAdjuntos.push(new AttachmentBuilder(audioUrl, { name: 'audio_klint.mp3' }));

    let textoFinal = respuesta;
    if (gifUrl) textoFinal = `${respuesta}\n${gifUrl}`.trim();

    const textoLimpio = textoFinal.length > 2000 ? textoFinal.slice(0, 1995) + '...' : textoFinal;

    if (esDM || conteoMensajes <= 3) {
      await message.channel.send({ content: textoLimpio, files: archivosAdjuntos });
    } else {
      await message.reply({ content: textoLimpio, files: archivosAdjuntos });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
