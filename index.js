const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const path = require('path');
const fs = require('fs');

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
    return 'Eres Klint. Habla casual, respuestas muy cortas e informales.';
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

// Client de Discord con TODOS los Intents de Presencia y Miembros habilitados
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

// REST API para Firebase Realtime Database
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
          listaComunidad.push(`- ${info.perfil.username} (Apodo: ${info.perfil.displayName || info.perfil.username}, ID: <@${id}>): ${ultimasMemorias || 'Conocido en la comunidad'}`);
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
    const promptEvaluacion = `Analiza si este mensaje enviado por ${user.username} contiene datos personales, gustos, anécdotas o información clave para recordar sobre él/ella.
MENSAJE: "${mensajeUsuario}"

Si NO contiene nada relevante de valor personal, responde ÚNICAMENTE: NO.
Si SÍ contiene datos importantes, responde con un resumen corto de una línea de lo que debes recordar de ${user.username}.`;

    const resultado = await consultarGemini([{ text: promptEvaluacion }], 80);
    const textoRespuesta = resultado.trim();

    const resumenParaGuardar = (!textoRespuesta || textoRespuesta.toUpperCase().startsWith('NO')) ? null : textoRespuesta;
    await actualizarPerfilYMemoria(user.id, user.username, user.displayName || user.username, mensajeUsuario, resumenParaGuardar);
  } catch (err) {
    logEvent(`Error evaluando memoria: ${err.message}`);
  }
}

// Generación autónoma de estado impredecible
async function actualizarEstadoIA() {
  try {
    const promptEstado = 'Escribe un estado super corto para Discord (máximo 4 palabras) de algo casual. Solo el texto sin comillas.';
    const textoGenerado = await consultarGemini([{ text: promptEstado }], 30);
    const textoEstado = textoGenerado.trim().replace(/^["']|["']$/g, '') || 'modo chill';

    const estadosVisibilidad = ['online', 'idle', 'dnd'];
    const estadoAleatorio = estadosVisibilidad[Math.floor(Math.random() * estadosVisibilidad.length)];

    client.user.setPresence({
      status: estadoAleatorio,
      activities: [{ name: textoEstado, type: ActivityType.Custom }]
    });
    logEvent(`Estado cambiado a [${estadoAleatorio}]: ${textoEstado}`);
  } catch (error) {
    logEvent(`Error al generar estado autónomo: ${error.message}`);
  }
}

function programarCambioEstadoRandom() {
  const minutosRandom = Math.floor(Math.random() * (40 - 8 + 1)) + 8;
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

// Extrae con detalle el ESTADO PERSONALIZADO (Perfil) y la ACTIVIDAD EN JUEGO/APP de un usuario
function obtenerDetallesPresenciaCompleta(member) {
  if (!member || !member.presence) return { customStatus: 'Sin estado personalizado', actividad: 'Ninguna' };

  const pres = member.presence;
  let customStatus = 'Sin estado personalizado';
  let actividadesList = [];

  if (pres.activities && pres.activities.length > 0) {
    pres.activities.forEach(act => {
      if (act.type === ActivityType.Custom || act.type === 4) {
        const texto = act.state || act.name || '';
        const emoji = act.emoji ? `${act.emoji.name} ` : '';
        customStatus = `${emoji}${texto}`.trim() || 'Sin estado personalizado';
      } else if (act.type === ActivityType.Playing) {
        actividadesList.push(`Jugando a ${act.name}`);
      } else if (act.type === ActivityType.Listening) {
        actividadesList.push(`Escuchando ${act.name}`);
      } else if (act.type === ActivityType.Streaming) {
        actividadesList.push(`Transmitiendo ${act.name}`);
      } else if (act.type === ActivityType.Watching) {
        actividadesList.push(`Viendo ${act.name}`);
      }
    });
  }

  return {
    customStatus,
    actividad: actividadesList.length > 0 ? actividadesList.join(' | ') : 'Ninguna'
  };
}

// Procesar respuesta con soporte completo para Stickers, Presencia y Miembros
async function procesarRespuestaIA(canal, promptUsuario, adjuntos = [], esDM = false, usuarioAutor = null) {
  try {
    const systemInstruction = cargarSystemInstruction();
    
    // 1. Obtener historial reciente
    const mensajesPrevios = await canal.messages.fetch({ limit: 6 });
    const historialFormateado = mensajesPrevios.reverse().map(m => {
      const usuarioNombre = m.author.username;
      const usuarioId = m.author.id;
      const esBot = m.author.bot ? '[BOT]' : '[USUARIO]';
      let contenido = m.content;

      // Detección de STICKERS de Discord
      if (m.stickers && m.stickers.size > 0) {
        const nombresStickers = m.stickers.map(s => `[Sticker enviado: "${s.name}"]`).join(' ');
        contenido = `${contenido} ${nombresStickers}`.trim();
      }

      // Extracción de datos de perfil y actividad
      let presenciaInfo = { customStatus: 'Sin estado', actividad: 'Ninguna' };
      if (m.member) {
        presenciaInfo = obtenerDetallesPresenciaCompleta(m.member);
      }
      
      return `${esBot} [ID: ${usuarioId}] ${usuarioNombre} (Etiqueta: <@${usuarioId}>) [Estado de Perfil: "${presenciaInfo.customStatus}"] [Actividad Actual: "${presenciaInfo.actividad}"]: ${contenido}`;
    }).join('\n');

    // 2. Cargar memorias específicas del usuario que escribe
    let contextoMemoriaAutor = '';
    if (usuarioAutor) {
      const datosFirebase = await obtenerMemoriaUsuario(usuarioAutor.id);
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        const ultimasMemorias = memoriasArray.slice(-4).map(m => `- ${m.resumen}`).join('\n');
        contextoMemoriaAutor = `\nLO QUE SABES DE QUIEN TE HABLA AHORA (${usuarioAutor.username}):\n${ultimasMemorias}\n`;
      }
    }

    // 3. Cargar directorio global de conocidos
    const personasConocidas = await obtenerTodosLosUsuariosConocidos();
    const listaConocidosTexto = personasConocidas.length > 0
      ? `\nPERSONAS CONOCIDAS EN LA COMUNIDAD (Usa esta lista si preguntan por alguien):\n${personasConocidas.join('\n')}\n`
      : '';

    const tipoEntorno = esDM ? 'CHAT PRIVADO (DM)' : 'CHAT PÚBLICO EN SERVIDOR';

    const promptText = `${systemInstruction}

ENTORNO: ${tipoEntorno}
INSTRUCCIÓN DE STICKERS: Si en el historial ves que enviaron un [Sticker enviado: "..."], reacciona a él o coméntalo si tiene sentido en la charla.
INSTRUCCIÓN DE MENCIONES: Usa <@ID_DEL_USUARIO> cuando etiquetes a alguien.
${contextoMemoriaAutor}
${listaConocidosTexto}
HISTORIAL RECIENTE Y DETALLADO DEL CHAT:
${historialFormateado}

MENSAJE ACTUAL DE RESPUESTA A ATENDER (Enviado por ${usuarioAutor?.username || 'Usuario'}):
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

    const respuesta = await consultarGemini(parts, 120);

    if (usuarioAutor) {
      evaluarYGuardarMemoria(usuarioAutor, promptUsuario);
    }

    return { respuesta, conteoMensajes: mensajesPrevios.size };
  } catch (error) {
    logEvent(`Error en procesarRespuestaIA: ${error.message}`);
    return { respuesta: 'me dio un lag en el cerebro, intenta de nuevo.', conteoMensajes: 0 };
  }
}

// Slash Commands (/klint)
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'klint') {
    await interaction.deferReply();
    const pregunta = interaction.options.getString('pregunta');
    const esDM = !interaction.guild;
    const { respuesta } = await procesarRespuestaIA(interaction.channel, pregunta, [], esDM, interaction.user);
    
    if (respuesta.length > 2000) {
      await interaction.editReply(respuesta.slice(0, 1995) + '...');
    } else {
      await interaction.editReply(respuesta);
    }
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
    await actualizarEstadoIA();
    
    if (esDM) {
      await message.channel.send('listo, ya lo cambié.');
    } else {
      await message.reply('listo, ya lo cambié.');
    }
    return;
  }

  if (esDM || fueMencionadoDirectamente || contieneNombre || (tieneAdjuntos && contieneNombre) || (tieneStickers && contieneNombre)) {
    await message.channel.sendTyping();
    
    const adjuntosArray = Array.from(message.attachments.values());
    const { respuesta, conteoMensajes } = await procesarRespuestaIA(message.channel, message.content, adjuntosArray, esDM, message.author);
    
    const textoLimpio = respuesta.length > 2000 ? respuesta.slice(0, 1995) + '...' : respuesta;

    if (esDM || conteoMensajes <= 3) {
      await message.channel.send(textoLimpio);
    } else {
      await message.reply(textoLimpio);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
