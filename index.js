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

app.post('/api/stats', validarKey, (req, res) => {
  res.json({
    guilds: client.guilds.cache.size,
    ping: client.ws.ping
  });
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

app.post('/api/send-message', validarKey, async (req, res) => {
  try {
    const { channelId, message } = req.body;
    const channel = await client.channels.fetch(channelId);
    if (channel) {
      await channel.send(message);
      logEvent(`Mensaje enviado vía Dashboard al canal ${channelId}`);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Canal no encontrado' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  logEvent(`Servidor HTTP activo en puerto ${PORT}`);
});

// Auto-ping
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
  programarCambioEstadoRandom();
  iniciarBucleInactividad();
});

// Modelos Gemini con redundancia
const MODELOS_FALLBACK = [
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent',
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
];

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

// Generación de estado autónomo en momentos impredecibles
async function actualizarEstadoIA(peticionManual = null) {
  try {
    let promptEstado = 'Genera un texto corto de estado para Discord de lo que estaría haciendo un usuario informal en su compu en este instante (máximo 5 palabras). Responde ÚNICAMENTE con el texto del estado.';
    if (peticionManual) {
      promptEstado = `Genera un estado corto de Discord basado en esta solicitud: ${peticionManual}. Máximo 5 palabras, responde solo con el estado.`;
    }

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

// Programación a tiempos totalmente aleatorios (entre 5 y 60 minutos)
function programarCambioEstadoRandom() {
  const minutosRandom = Math.floor(Math.random() * (60 - 5 + 1)) + 5;
  setTimeout(async () => {
    await actualizarEstadoIA();
    programarCambioEstadoRandom();
  }, minutosRandom * 60 * 1000);
}

// Función para revisar canales e iniciar conversación de la nada si están inactivos
function iniciarBucleInactividad() {
  setInterval(async () => {
    try {
      client.guilds.cache.forEach(async (guild) => {
        const canalTexto = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
        if (!canalTexto) return;

        const mensajes = await canalTexto.messages.fetch({ limit: 1 });
        const ultimoMensaje = mensajes.first();

        if (ultimoMensaje) {
          const tiempoInactivo = Date.now() - ultimoMensaje.createdTimestamp;
          // Si han pasado más de 3 horas sin mensajes, Klint habla de la nada
          if (tiempoInactivo > 3 * 60 * 60 * 1000) {
            await canalTexto.sendTyping();
            const promptBreaker = `${cargarSystemInstruction()}\nEl chat ha estado inactivo por varias horas. Lanza un comentario o pregunta casual e informal para romper el hielo en el servidor.`;
            const respuesta = await consultarGeminiMultimodelo([{ text: promptBreaker }]);
            if (respuesta) {
              await canalTexto.send(respuesta);
              logEvent(`Klint inició conversación por inactividad en ${guild.name}`);
            }
          }
        }
      });
    } catch (e) {
      logEvent(`Error en bucle de inactividad: ${e.message}`);
    }
  }, 60 * 60 * 1000); // Revisa cada hora
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
      
      // Captura de actividades, estado personalizado y estado de visibilidad del usuario
      let estadoInfo = '';
      if (m.member) {
        const pres = m.member.presence;
        const statusVis = pres ? pres.status : 'offline';
        let actividadText = '';
        
        if (pres && pres.activities.length > 0) {
          actividadText = pres.activities.map(a => `${a.type === ActivityType.Custom ? 'Estado' : 'Jugando/Escuchando'}: ${a.name}`).join(' | ');
        }
        estadoInfo = ` [Visibilidad: ${statusVis}${actividadText ? ' | ' + actividadText : ''}]`;
      }

      return `${usuario}${estadoInfo}: ${contenido}`;
    }).join('\n');

    const promptText = `${systemInstruction}

HISTORIAL RECIENTE DEL CHAT (con datos de presencia y estado de usuarios):
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

  // Si le piden cambiar de estado directamente en el chat
  if (contieneNombre && (textoLower.includes('cambia tu estado') || textoLower.includes('ponte de estado'))) {
    await message.channel.sendTyping();
    await actualizarEstadoIA(message.content);
    await message.reply('listo, ya cambié mi estado de actividad.');
    return;
  }

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
