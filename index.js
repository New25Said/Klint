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

// Servidor Express
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP activo en puerto ${PORT}`);
});

// Auto-ping a la URL fija de Render
const RENDER_URL = 'https://klint-gxww.onrender.com';
setInterval(() => {
  fetch(RENDER_URL)
    .then(() => console.log('Self-ping exitoso para mantener Klint activo.'))
    .catch((err) => console.error('Error en self-ping:', err));
}, 10 * 60 * 1000);

// Inicialización de la API de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });

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

  actualizarEstadoAutonomo();
  setInterval(actualizarEstadoAutonomo, 20 * 60 * 1000);
});

// Función autónoma para actualizar presencia
async function actualizarEstadoAutonomo() {
  try {
    const promptEstado = 'Genera un estado corto de Discord para un usuario casual (máximo 5 palabras). Responde SOLO con el texto del estado, sin comillas ni explicaciones.';
    const result = await model.generateContent(promptEstado);
    const response = await result.response;
    const textoEstado = response.text()?.trim() || 'viendo el chat';

    const estados = ['online', 'idle', 'dnd'];
    const estadoAleatorio = estados[Math.floor(Math.random() * estados.length)];

    client.user.setPresence({
      status: estadoAleatorio,
      activities: [{ name: textoEstado, type: ActivityType.Custom }]
    });
    console.log(`Estado cambiado a [${estadoAleatorio}]: ${textoEstado}`);
  } catch (error) {
    console.error('Error al actualizar estado autónomo:', error);
  }
}

// Función auxiliar para convertir una URL de imagen a un objeto Part de Gemini
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

// Procesar interacción con la IA (Texto + Contexto + Soporte para imágenes)
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

    // Si existen imágenes/archivos adjuntos en el mensaje actual, se convierten para la IA
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
