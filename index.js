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
    return 'Eres Klint, un usuario casual de Discord. Respuestas cortas, fluidas y espontáneas.';
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

// Auto-ping para Render Free Tier
const RENDER_URL = 'https://klint-gxww.onrender.com';
setInterval(() => {
  fetch(RENDER_URL)
    .then(() => logEvent('Self-ping exitoso para mantener Klint activo.'))
    .catch((err) => console.error('Error en self-ping:', err));
}, 10 * 60 * 1000);

// Client de Discord con los Intents necesarios
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

// Lista de modelos con fallback automático
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

// Generación autónoma de presencia
async function actualizarEstadoIA(peticionManual = null) {
  try {
    let promptEstado = 'Genera un estado muy corto para Discord (máximo 4 palabras) de algo que diría o haría un usuario de internet. Solo el texto sin comillas.';
    if (peticionManual) {
      promptEstado = `Genera un estado corto de Discord basado en esta solicitud: ${peticionManual}. Máximo 4 palabras, solo el texto.`;
    }

    const textoGenerado = await consultarGeminiMultimodelo([{ text: promptEstado }]);
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
          if (tiempoInactivo > 3 * 60 * 60 * 1000) {
            await canalTexto.sendTyping();
            const promptBreaker = `${cargarSystemInstruction()}\nEl chat está callado hace horas. Di una sola frase muy corta y casual para romper el silencio.`;
            const respuesta = await consultarGeminiMultimodelo([{ text: promptBreaker }]);
            if (respuesta) {
              await canalTexto.send(respuesta);
              logEvent(`Klint inició conversación autónoma en ${guild.name}`);
            }
          }
        }
      });
    } catch (e) {
      logEvent(`Error en bucle de inactividad: ${e.message}`);
    }
  }, 60 * 60 * 1000);
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

function obtenerEstadoPersonalizadoUsuario(member) {
  if (!member || !member.presence) return 'Sin estado';
  const pres = member.presence;
  const customStatusActivity = pres.activities.find(a => a.type === ActivityType.Custom || a.type === 4);
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
    // Reducimos el historial a los últimos 5 mensajes para evitar que arrastre patrones largos
    const mensajesPrevios = await canal.messages.fetch({ limit: 5 });
    
    const historialFormateado = mensajesPrevios.reverse().map(m => {
      const usuario = m.author.username;
      const contenido = m.content;
      let estadoPersonalizado = 'Sin estado';

      if (m.member) {
        estadoPersonalizado = obtenerEstadoPersonalizadoUsuario(m.member);
      }

      return `${usuario} [Estado: "${estadoPersonalizado}"]: ${contenido}`;
    }).join('\n');

    const tipoEntorno = esDM ? 'CHAT PRIVADO (DM)' : 'CHAT PÚBLICO SERVIDOR';

    const promptText = `${systemInstruction}

ENTORNO: ${tipoEntorno}
HISTORIAL DEL CHAT:
${historialFormateado}

MENSAJE ACTUAL A RESPONDER:
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
    await actualizarEstadoIA(message.content);
    
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
