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

// Limpia y extrae la URL pura de Firebase eliminando corchetes, paréntesis o Markdown
function obtenerFirebaseUrl() {
  let url = process.env.FIREBASE_DATABASE_URL || '';
  
  // Extrae la URL si fue pegada como un link Markdown [text](http...)
  const matchMarkdown = url.match(/\((https?:\/\/[^\)]+)\)/);
  if (matchMarkdown) {
    url = matchMarkdown[1];
  }

  // Limpia caracteres no deseados, comillas o corchetes
  url = url.replace(/[\[\]()'"]/g, '').trim();

  if (url && !url.startsWith('http')) {
    url = `https://${url}`;
  }
  return url;
}

// Servidor Express
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Middleware de autenticación con 'saidkey'
function validarKey(req, res, next) {
  const { key } = req.body;
  const claveCorrecta = process.env.saidkey || process.env.SAIDKEY;
  if (key && claveCorrecta && key === claveCorrecta) {
    next();
  } else {
    res.status(401).json({ error: 'Clave no autorizada' });
  }
}

// Endpoints del Dashboard
app.post('/api/login', validarKey, (req, res) => res.json({ success: true }));
app.post('/api/stats', validarKey, (req, res) => {
  res.json({ guilds: client.guilds.cache.size, ping: client.ws.ping });
});
app.post('/api/get-prompt', validarKey, (req, res) => res.json({ prompt: cargarSystemInstruction() }));
app.post('/api/save-prompt', validarKey, (req, res) => {
  try {
    fs.writeFileSync(path.join(__dirname, 'system_instruction.txt'), req.body.prompt, 'utf8');
    logEvent('Instrucciones de personalidad actualizadas.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo guardar el archivo' });
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
          generationConfig: {
            maxOutputTokens: maxTokens
          }
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

// Funciones REST para Firebase Realtime Database
async function obtenerMemoriaUsuario(userId) {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl || !dbUrl.startsWith('http')) {
    logEvent('FIREBASE_DATABASE_URL no configurada o inválida.');
    return null;
  }

  try {
    const cleanUrl = dbUrl.endsWith('/') ? dbUrl : `${dbUrl}/`;
    const res = await fetch(`${cleanUrl}usuarios/${userId}.json`);
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    logEvent(`Error leyendo Firebase: ${err.message}`);
  }
  return null;
}

async function guardarMemoriaUsuario(userId, mensaje, resumen) {
  const dbUrl = obtenerFirebaseUrl();
  if (!dbUrl || !dbUrl.startsWith('http')) {
    logEvent('Error: FIREBASE_DATABASE_URL debe ser una URL válida.');
    return;
  }

  try {
    const cleanUrl = dbUrl.endsWith('/') ? dbUrl : `${dbUrl}/`;
    const resPush = await fetch(`${cleanUrl}usuarios/${userId}/memorias.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mensaje: mensaje,
        resumen: resumen,
        fecha: new Date().toISOString()
      })
    });

    if (resPush.ok) {
      logEvent(`[Firebase] Memoria guardada correctamente para usuario ${userId}`);
    } else {
      const errData = await resPush.text();
      logEvent(`[Firebase Error] Código ${resPush.status}: ${errData}`);
    }
  } catch (err) {
    logEvent(`Error conectando a Firebase: ${err.message}`);
  }
}

// Analizador en segundo plano para memoria de Firebase
async function evaluarYGuardarMemoria(userId, mensajeUsuario) {
  try {
    const promptEvaluacion = `Analiza si este mensaje enviado por un usuario contiene información personal importante, gustos, secretos o datos clave que valga la pena recordar a futuro.
MENSAJE: "${mensajeUsuario}"

Si NO contiene nada relevante de valor personal, responde ÚNICAMENTE con la palabra: NO.
Si SÍ contiene datos importantes a recordar, responde con una sola línea corta que resuma el dato personal a guardar.`;

    const resultado = await consultarGemini([{ text: promptEvaluacion }], 80);
    const textoRespuesta = resultado.trim();

    if (textoRespuesta && !textoRespuesta.toUpperCase().startsWith('NO')) {
      await guardarMemoriaUsuario(userId, mensajeUsuario, textoRespuesta);
    }
  } catch (err) {
    logEvent(`Error evaluando memoria: ${err.message}`);
  }
}

// Generación de estado para Klint
async function actualizarEstadoIA() {
  try {
    const promptEstado = 'Escribe un estado super corto de Discord (máximo 4 palabras) de algo que diría un usuario casual. Solo el texto sin comillas.';
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
  const minutosRandom = Math.floor(Math.random() * (45 - 10 + 1)) + 10;
  setTimeout(async () => {
    await actualizarEstadoIA();
    programarCambioEstadoRandom();
  }, minutosRandom * 60 * 1000);
}

async function urlToGenerativePart(url) {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return {
      inline_data: {
        data: buffer.toString('base64'),
        mime_type: response.headers.get('content-type') || 'image/png'
      }
    };
  } catch (error) {
    return null;
  }
}

function obtenerEstadoPersonalizadoUsuario(member) {
  if (!member || !member.presence) return 'Sin estado';
  const customStatusActivity = member.presence.activities.find(a => a.type === ActivityType.Custom || a.type === 4);
  if (customStatusActivity) {
    const textoEstado = customStatusActivity.state || customStatusActivity.name || '';
    const emojiEstado = customStatusActivity.emoji ? `${customStatusActivity.emoji.name} ` : '';
    return `${emojiEstado}${textoEstado}`.trim() || 'Sin estado';
  }
  return 'Sin estado';
}

// Procesar interacción con la IA
async function procesarRespuestaIA(canal, promptUsuario, adjuntos = [], esDM = false, usuarioAutor = null) {
  try {
    const systemInstruction = cargarSystemInstruction();
    
    const mensajesPrevios = await canal.messages.fetch({ limit: 4 });
    const historialFormateado = mensajesPrevios.reverse().map(m => {
      const usuario = m.author.username;
      const contenido = m.content;
      let estadoPersonalizado = 'Sin estado';
      if (m.member) estadoPersonalizado = obtenerEstadoPersonalizadoUsuario(m.member);
      return `${usuario} [Estado: "${estadoPersonalizado}"]: ${contenido}`;
    }).join('\n');

    let contextoMemoria = '';
    if (usuarioAutor) {
      const datosFirebase = await obtenerMemoriaUsuario(usuarioAutor.id);
      if (datosFirebase && datosFirebase.memorias) {
        const memoriasArray = Object.values(datosFirebase.memorias);
        const ultimasMemorias = memoriasArray.slice(-4).map(m => `- ${m.resumen}`).join('\n');
        contextoMemoria = `\nLO QUE RECUERDAS DE ESTE USUARIO DE CONVERSACIONES ANTERIORES:\n${ultimasMemorias}\n`;
      }
    }

    const tipoEntorno = esDM ? 'CHAT PRIVADO (DM)' : 'CHAT PÚBLICO EN SERVIDOR';

    const promptText = `${systemInstruction}

ENTORNO: ${tipoEntorno}
${contextoMemoria}
HISTORIAL RECIENTE DEL CHAT:
${historialFormateado}

MENSAJE ACTUAL DE RESPUESTA:
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
      evaluarYGuardarMemoria(usuarioAutor.id, promptUsuario);
    }

    return respuesta || 'jaja no sé qué decir';
  } catch (error) {
    logEvent(`Error en procesarRespuestaIA: ${error.message}`);
    return 'me dio un lag en el cerebro, intenta de nuevo.';
  }
}

// Manejo de Slash Commands (/klint)
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'klint') {
    await interaction.deferReply();
    const pregunta = interaction.options.getString('pregunta');
    const esDM = !interaction.guild;
    const respuesta = await procesarRespuestaIA(interaction.channel, pregunta, [], esDM, interaction.user);
    
    if (respuesta.length > 2000) {
      await interaction.editReply(respuesta.slice(0, 1995) + '...');
    } else {
      await interaction.editReply(respuesta);
    }
  }
});

// Manejo de Mensajes Directos y Servidores
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const esDM = !message.guild;
  const textoLower = message.content.toLowerCase();
  
  const patronNombres = /\b(clin|klin|klint|klinty)\b/i;
  const fueMencionadoDirectamente = message.mentions.has(client.user.id);
  const contieneNombre = patronNombres.test(textoLower);
  const tieneAdjuntos = message.attachments.size > 0;

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

  if (esDM || fueMencionadoDirectamente || contieneNombre || (tieneAdjuntos && contieneNombre)) {
    await message.channel.sendTyping();
    
    const adjuntosArray = Array.from(message.attachments.values());
    const respuesta = await procesarRespuestaIA(message.channel, message.content, adjuntosArray, esDM, message.author);
    
    if (respuesta.length > 2000) {
      if (esDM) {
        await message.channel.send(respuesta.slice(0, 1995) + '...');
      } else {
        await message.reply(respuesta.slice(0, 1995) + '...');
      }
    } else {
      if (esDM) {
        await message.channel.send(respuesta);
      } else {
        await message.reply(respuesta);
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
