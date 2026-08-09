const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const path = require('path');
const fs = require('fs');

// Registro interno de logs para el Dashboard
const systemLogs = [];
function logEvent(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] ${msg}`;
  console.log(entry);
  systemLogs.unshift(entry);
  if (systemLogs.length > 30) systemLogs.pop();
}

// Carga la instrucción de sistema desde el archivo txt independiente
function cargarSystemInstruction() {
  try {
    const filePath = path.join(__dirname, 'system_instruction.txt');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logEvent('Error al cargar system_instruction.txt');
    return 'Eres Klint, un usuario más de la comunidad de Discord. Habla relajado y casual.';
  }
}

// Servidor Express
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Middleware de verificación para la clave 'saidkey'
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
app.post('/api/login', validarKey, (req, res) => {
  res.json({ success: true });
});

app.post('/api/get-prompt', validarKey, (req, res) => {
  res.json({ prompt: cargarSystemInstruction() });
});

app.post('/api/save-prompt', validarKey, (req, res) => {
  try {
    const { prompt } = req.body;
    fs.writeFileSync(path.join(__dirname, 'system_instruction.txt'), prompt, 'utf8');
    logEvent('Instrucciones de personalidad actualizadas desde el Dashboard');
    res.json({ success: true });
  } catch (err) {
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

app.listen(PORT, () => {
  logEvent(`Servidor HTTP activo en puerto ${PORT}`);
});

// Auto-ping para mantener Render activo
const RENDER_URL = 'https://klint-gxww.onrender.com';
setInterval(() => {
  fetch(RENDER_URL)
    .then(() => logEvent('Self-ping exitoso para mantener Klint activo.'))
    .catch((err) => console.error('Error en self-ping:', err));
}, 10 * 60 * 1000);

// Inicialización de Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

const commands = [
  new SlashCommandBuilder()
    .setName('klint')
    .setDescription('Hazle una pregunta o habla con Klint')
    .addStringOption(option =>
      option.setName('pregunta')
        .setDescription('Lo que quieres preguntarle a Klint')
        .setRequired(true)
    )
].map(command => command.toJSON());

client.once('clientReady', async () => {
  logEvent(`Klint ha iniciado sesión como ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    logEvent('Comandos /klint registrados correctamente.');
  } catch (error) {
    logEvent(`Error al registrar comandos slash: ${error.message}`);
  }

  await actualizarEstadoIA();
  programarSiguienteCambioEstado();
});

// Lista de modelos vigentes ordenada por capacidad y disponibilidad gratuita
const MODELOS_FALLBACK = [
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
];

// Consulta a Gemini con redundancia automática entre modelos
async function consultarGeminiMultimodelo(parts) {
  let ultimoError = null;

  for (const endpoint of MODELOS_FALLBACK) {
    try {
      const url = `${endpoint}?key=${process.env.GEMINI_API_KEY}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
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

  throw new Error(`Todos los modelos fallaron. Último error: ${ultimoError}`);
}

// Generación autónoma de presencia por la IA
async function actualizarEstadoIA() {
  try {
    const promptEstado = 'Genera un texto corto de estado para Discord de lo que estaría haciendo un usuario informal en su compu en este instante (máximo 5 palabras). Responde ÚNICAMENTE con el texto del estado.';
    
    const textoGenerado = await consultarGeminiMultimodelo([{ text: promptEstado }]);
    const textoEstado = textoGenerado.trim().replace(/^["']|["']$/g, '') || 'en la compu';

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

function programarSiguienteCambioEstado() {
  const minutosAleatorios = Math.floor(Math.random() * (50 - 20 + 1)) + 20;
  setTimeout(async () => {
    await actualizarEstadoIA();
    programarSiguienteCambioEstado();
  }, minutosAleatorios * 60 * 1000);
}

async function urlToGenerativePart(url) {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = response.headers.get('content-type') || 'image/png';
    return {
      inline_data: {
        data: buffer.toString('base64'),
        mime_type: mimeType
      }
    };
  } catch (error) {
    logEvent(`Error procesando imagen: ${error.message}`);
    return null;
  }
}

async function procesarRespuestaIA(canal, promptUsuario, adjuntos = []) {
  try {
    const systemInstruction = cargarSystemInstruction();
    const mensajesPrevios = await canal.messages.fetch({ limit: 10 });
    
    const historialFormateado = mensajesPrevios.reverse().map(m => {
      const usuario = m.author.username;
      const contenido = m.content;
      let actividad = '';
      if (m.member?.presence?.activities?.length) {
        const act = m.member.presence.activities[0];
        actividad = ` [Actividad: ${act.name}]`;
      }
      return `${usuario}${actividad}: ${contenido}`;
    }).join('\n');

    const promptText = `${systemInstruction}

HISTORIAL RECIENTE DEL CHAT:
${historialFormateado}

PREGUNTA/MENSAJE ACTUAL A RESPONDER:
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

    const respuesta = await consultarGeminiMultimodelo(parts);
    return respuesta || 'banco de memoria vacío, no sé qué decir jsjs';
  } catch (error) {
    logEvent(`Error en procesarRespuestaIA: ${error.message}`);
    return 'me dio un lag en el cerebro, intenta de nuevo en un rato.';
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'klint') {
    await interaction.deferReply();
    const pregunta = interaction.options.getString('pregunta');
    const respuesta = await procesarRespuestaIA(interaction.channel, pregunta);
    
    if (respuesta.length > 2000) {
      await interaction.editReply(respuesta.slice(0, 1995) + '...');
    } else {
      await interaction.editReply(respuesta);
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const esDM = !message.guild;
  const textoLower = message.content.toLowerCase();
  
  const patronNombres = /\b(clin|klin|klint|klinty)\b/i;
  const fueMencionadoDirectamente = message.mentions.has(client.user.id);
  const contieneNombre = patronNombres.test(textoLower);
  const tieneAdjuntos = message.attachments.size > 0;

  if (esDM || fueMencionadoDirectamente || contieneNombre || (tieneAdjuntos && contieneNombre)) {
    await message.channel.sendTyping();
    
    const adjuntosArray = Array.from(message.attachments.values());
    const respuesta = await procesarRespuestaIA(message.channel, message.content, adjuntosArray);
    
    if (respuesta.length > 2000) {
      await message.reply(respuesta.slice(0, 1995) + '...');
    } else {
      await message.reply(respuesta);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
