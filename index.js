const { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const path = require('path');
const fs = require('fs');

// Carga la instrucción de sistema desde un archivo independiente
function cargarSystemInstruction() {
  try {
    const filePath = path.join(__dirname, 'system_instruction.txt');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error('No se pudo cargar system_instruction.txt, usando predeterminado:', error);
    return 'Eres Klint, un usuario más de la comunidad de Discord. Habla relajado y casual.';
  }
}

// Servidor Express para servir index.html y mantener Render activo
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP activo en puerto ${PORT}`);
});

// Auto-ping con la URL en duro para Render Free Tier (cada 10 minutos)
const RENDER_URL = 'https://klint-gxww.onrender.com';
setInterval(() => {
  fetch(RENDER_URL)
    .then(() => console.log('Self-ping exitoso para mantener Klint activo.'))
    .catch((err) => console.error('Error en self-ping:', err));
}, 10 * 60 * 1000);

// Inicialización de la API de Gemini usando el modelo oficial estable
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// Inicialización del Cliente de Discord
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

// Registro de comandos Slash
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
  console.log(`Klint ha iniciado sesión como ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('Comandos /klint registrados correctamente.');
  } catch (error) {
    console.error('Error al registrar comandos slash:', error);
  }

  // Establecer estado inicial y programar cambios autónomos
  actualizarEstadoAutonomo();
  // Cambia de estado en intervalos aleatorios entre 15 y 45 minutos
  programarSiguienteCambioEstado();
});

// Banco extendido de ideas para estados autónomos
const ACTIVIDADES_CASUALES = [
  'viendo videos en youtube',
  'escuchando lofi',
  'jugando en la laptop',
  'buscando que comer',
  'scrolleando en reddit',
  'arreglando un bug raro',
  'tomando agua',
  'escuchando un podcast',
  'pensando si dormir o no',
  'viendo memes de código',
  'probando cosas en discord',
  'modo chill'
];

// Función autónoma para cambiar visibilidad y actividad cuando Klint quiera
async function actualizarEstadoAutonomo() {
  try {
    const estadosVisibilidad = ['online', 'idle', 'dnd'];
    const estadoAleatorio = estadosVisibilidad[Math.floor(Math.random() * estadosVisibilidad.length)];
    
    let textoEstado = '';

    // Intenta usar la IA si hay cuota disponible, si no, usa el generador casual
    try {
      const prompt = 'Escribe un estado de Discord súper corto (máximo 4 palabras) de algo que haría un usuario casual en su compu. Responde SOLO con el texto.';
      const result = await model.generateContent(prompt);
      const res = await result.response;
      textoEstado = res.text()?.trim().replace(/^["']|["']$/g, '');
    } catch (e) {
      // Fallback local instantáneo sin gastar cuota si la API está ocupada
      textoEstado = ACTIVIDADES_CASUALES[Math.floor(Math.random() * ACTIVIDADES_CASUALES.length)];
    }

    if (!textoEstado) {
      textoEstado = ACTIVIDADES_CASUALES[Math.floor(Math.random() * ACTIVIDADES_CASUALES.length)];
    }

    client.user.setPresence({
      status: estadoAleatorio,
      activities: [{ name: textoEstado, type: ActivityType.Custom }]
    });
    console.log(`Klint cambió su estado a [${estadoAleatorio}]: ${textoEstado}`);
  } catch (error) {
    console.error('Error al actualizar estado autónomo:', error);
  }
}

// Programa cambios de estado en tiempos impredecibles para sonar más humano
function programarSiguienteCambioEstado() {
  const minutosAleatorios = Math.floor(Math.random() * (45 - 15 + 1)) + 15;
  setTimeout(() => {
    actualizarEstadoAutonomo();
    programarSiguienteCambioEstado();
  }, minutosAleatorios * 60 * 1000);
}

// Convierte URL de adjuntos a formato multimodal de Gemini
async function urlToGenerativePart(url) {
  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = response.headers.get('content-type') || 'image/png';
    return {
      inlineData: {
        data: buffer.toString('base64'),
        mimeType
      }
    };
  } catch (error) {
    console.error('Error procesando imagen adjunta:', error);
    return null;
  }
}

// Procesar interacción con la IA con captura de límite de cuota
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

    const contents = [promptText];

    if (adjuntos.length > 0) {
      for (const attachment of adjuntos) {
        if (attachment.contentType && attachment.contentType.startsWith('image/')) {
          const imagePart = await urlToGenerativePart(attachment.url);
          if (imagePart) contents.push(imagePart);
        }
      }
    }

    const result = await model.generateContent(contents);
    const response = await result.response;

    return response.text() || 'banco de memoria vacío, no sé qué decir jsjs';
  } catch (error) {
    console.error('Error en Gemini API:', error);
    if (error.status === 429 || error.message?.includes('429')) {
      return 'ando con un poco de lag por tantas peticiones jsjs, dame unos segundos y me repito.';
    }
    return 'me dio un lag en el cerebro, intenta de nuevo en un rato.';
  }
}

// Manejo de Comandos Slash (/klint)
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

// Manejo de Mensajes Directos, Menciones y Nombres
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
