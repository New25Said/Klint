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

// Discord Client
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

async function consultarGemini(parts, maxTokens = 100) {
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

// Generación de estado impredecible y libre por la IA
async function actualizarEstadoIA(peticionManual = null) {
  try {
    let promptEstado = 'Inventa un estado de Discord totalmente libre, aleatorio que pondría un usuario en su perfil (máximo 5-6 palabras). Responde ÚNICAMENTE con el texto, ponle la ortagrafia que quieras como si fueras un humano';
    if (peticionManual) {
      promptEstado = `Genera un estado libre para Discord basado en esto: ${peticionManual}. Máximo 5 palabras, solo texto.`;
    }

    const textoGenerado = await consultarGemini([{ text: promptEstado }], 25);
    const textoEstado = textoGenerado.trim().replace(/^["']|["']$/g, '').toLowerCase() || 'pensando en la nada';

    const estadosVisibilidad = ['online', 'idle', 'dnd'];
    const estadoAleatorio = estadosVisibilidad[Math.floor(Math.random() * estadosVisibilidad.length)];

    client.user.setPresence({
      status: estadoAleatorio,
      activities: [{ name: textoEstado, type: ActivityType.Custom }]
    });
    logEvent(`Estado liberado cambiado a [${estadoAleatorio}]: ${textoEstado}`);
  } catch (error) {
    logEvent(`Error al generar estado autónomo: ${error.message}`);
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

function obtenerDetallesPresenciaCompleta(member) {
  if (!member || !member.presence) return '';

  const pres = member.presence;
  let detalles = [];

  if (pres.activities && pres.activities.length > 0) {
    pres.activities.forEach(act => {
      if (act.type === ActivityType.Custom || act.type === 4) {
        const texto = act.state || act.name || '';
        if (texto) detalles.push(`Estado de perfil: "${texto}"`);
      } else if (act.name) {
        detalles.push(`Haciendo: ${act.name}`);
      }
    });
  }

  return detalles.length > 0 ? ` (${detalles.join(', ')})` : '';
}

// Procesar respuesta
async function procesarRespuestaIA(canal, promptUsuario, adjuntos = [], esDM = false, usuarioAutor = null) {
  try {
    const systemInstruction = cargarSystemInstruction();
    
    // 1. Historial en formato limpio
    const mensajesPrevios = await canal.messages.fetch({ limit: 5 });
    const historialFormateado = mensajesPrevios.reverse().map(m => {
      const usuarioNombre = m.author.username;
      const usuarioId = m.author.id;
      let contenido = m.content;

      if (m.stickers && m.stickers.size > 0) {
        const nombresStickers = m.stickers.map(s => `[Sticker: ${s.name}]`).join(' ');
        contenido = `${contenido} ${nombresStickers}`.trim();
      }

      let infoPresencia = '';
      if (m.member) {
        infoPresencia = obtenerDetallesPresenciaCompleta(m.member);
      }
      
      return `${usuarioNombre} (<@${usuarioId}>)${infoPresencia}: ${contenido}`;
    }).join('\n');

    // 2. Memorias del autor
    let contextoMemoriaAutor = '';
    if (usuarioAutor) {
      const datosFirebase = await obtenerMemoriaUsuario(usuarioAutor.id);
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        const ultimasMemorias = memoriasArray.slice(-3).map(m => `- ${m.resumen}`).join('\n');
        contextoMemoriaAutor = `\nRECUERDOS QUE TIENES DE ${usuarioAutor.username}:\n${ultimasMemorias}\n`;
      }
    }

    // 3. Usuarios conocidos
    const personasConocidas = await obtenerTodosLosUsuariosConocidos();
    const listaConocidosTexto = personasConocidas.length > 0
      ? `\nCONOCIDOS DE LA COMUNIDAD:\n${personasConocidas.join('\n')}\n`
      : '';

    const tipoEntorno = esDM ? 'CHAT PRIVADO (DM)' : 'CHAT PÚBLICO';

    const promptText = `${systemInstruction}

ENTORNO: ${tipoEntorno}
${contextoMemoriaAutor}
${listaConocidosTexto}
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

    const respuesta = await consultarGemini(parts, 100);

    if (usuarioAutor) {
      evaluarYGuardarMemoria(usuarioAutor, promptUsuario);
    }

    return { respuesta, conteoMensajes: mensajesPrevios.size };
  } catch (error) {
    logEvent(`Error en procesarRespuestaIA: ${error.message}`);
    return { respuesta: 'me dio un lag xd', conteoMensajes: 0 };
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
