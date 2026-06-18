require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

// ============================================================
//  CONFIGURACIÓN
// ============================================================
const COOLDOWN_MS = 3 * 60 * 1000;      // 1 solicitud cada 3 min por usuario
const CANTIDAD_MIN = 500;                // € mínimo aceptado
const CANTIDAD_MAX = 1000000;           // € máximo aceptado
const REGISTRO_PATH = path.join(__dirname, 'operaciones.jsonl');
const FALLOS_PATH = path.join(__dirname, 'operaciones_fallidas.jsonl');

// ============================================================
//  UTILIDADES
// ============================================================

// Escapa los caracteres especiales de MarkdownV2 para que Telegram no falle
function escaparMarkdown(texto) {
    return String(texto).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// Guarda una línea JSON en un archivo (append). Nunca lanza: solo loggea.
function guardarRegistro(archivo, objeto) {
    try {
        fs.appendFileSync(archivo, JSON.stringify(objeto) + '\n', 'utf8');
    } catch (err) {
        console.error(`No se pudo escribir en ${archivo}:`, err.message);
    }
}

// --- Telegram (sin librería, usando fetch nativo) ---
async function enviarTelegram(texto) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: texto,
            parse_mode: 'MarkdownV2',
        }),
    });
    if (!res.ok) {
        const detalle = await res.text();
        throw new Error(`Telegram error ${res.status}: ${detalle}`);
    }
    return res.json();
}

// ============================================================
//  ANTI-SPAM (cooldown por usuario, en memoria)
// ============================================================
const cooldowns = new Map(); // userId -> timestamp del último envío

function comprobarCooldown(userId) {
    const ahora = Date.now();
    const ultimo = cooldowns.get(userId);
    if (ultimo && ahora - ultimo < COOLDOWN_MS) {
        const restanteMs = COOLDOWN_MS - (ahora - ultimo);
        const minutos = Math.ceil(restanteMs / 60000);
        return { permitido: false, minutos };
    }
    return { permitido: true };
}

// Guarda temporalmente lo que el usuario rellenó, a la espera de confirmación
const pendientesConfirmacion = new Map(); // userId -> datos

// ============================================================
//  DISCORD CLIENT
// ============================================================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder()
        .setName('formulario')
        .setDescription('Abre el formulario de operación P2P')
        .toJSON(),
];

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(
        Routes.applicationGuildCommands(
            process.env.DISCORD_CLIENT_ID,
            process.env.DISCORD_GUILD_ID
        ),
        { body: commands }
    );
    console.log('Comando registrado.');
}

// Publica (o reutiliza) el mensaje fijo con el botón en el canal configurado.
async function publicarBotonFijo() {
    try {
        const canal = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        if (!canal) {
            console.error('No se encontró el canal DISCORD_CHANNEL_ID.');
            return;
        }

        // ¿Ya existe un botón válido del bot? Si es así, no republicamos.
        const mensajes = await canal.messages.fetch({ limit: 30 });
        const existente = mensajes.find(
            (m) =>
                m.author.id === client.user.id &&
                m.components.length > 0 &&
                m.components[0].components?.[0]?.customId === 'abrir_formulario'
        );

        if (existente) {
            console.log('El botón fijo ya existe, se reutiliza.');
            return;
        }

        // Limpia otros mensajes sueltos del bot (sin botón) para no dejar basura
        const mios = mensajes.filter((m) => m.author.id === client.user.id);
        for (const m of mios.values()) {
            await m.delete().catch(() => { });
        }

        const boton = new ButtonBuilder()
            .setCustomId('abrir_formulario')
            .setLabel('📝 RELLENAR FORMULARIO P2P')
            .setStyle(ButtonStyle.Success);

        await canal.send({
            content:
                '# 🪙 FORMULARIO DE OPERACIÓN P2P\n\n' +
                '## ⚠️ LEE ANTES DE EMPEZAR:\n' +
                '### 📍 El P2P se realiza **EN PERSONA** y **OBLIGATORIAMENTE EN VALENCIA, ESPAÑA**.\n' +
                '### 💵 **SOLO DAMOS EFECTIVO** — NO recibimos efectivo por el momento.\n\n' +
                'No se realizan operaciones a distancia bajo ningún concepto.\n\n' +
                '👇 **Pulsa el botón verde de abajo para rellenar tu solicitud:**',
            components: [new ActionRowBuilder().addComponents(boton)],
        });

        console.log('Botón fijo publicado en el canal.');
    } catch (err) {
        console.error('Error publicando el botón fijo:', err);
    }
}

// ============================================================
//  VALIDACIONES
// ============================================================

// Valida una fecha en formato DD/MM/AAAA. Devuelve {ok, valor} o {ok:false, error}
function validarFecha(entrada) {
    const limpio = entrada.trim();
    const m = limpio.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) {
        return { ok: false, error: 'El formato debe ser DD/MM/AAAA. Ejemplo: 25/12/2026' };
    }

    const dia = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10);
    const anio = parseInt(m[3], 10);

    if (mes < 1 || mes > 12) return { ok: false, error: 'El mes debe estar entre 01 y 12.' };
    if (dia < 1 || dia > 31) return { ok: false, error: 'El día no es válido.' };

    const fecha = new Date(anio, mes - 1, dia);
    if (fecha.getDate() !== dia || fecha.getMonth() !== mes - 1 || fecha.getFullYear() !== anio) {
        return { ok: false, error: 'Esa fecha no existe. Revísala (ejemplo válido: 25/12/2026).' };
    }

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    if (fecha < hoy) {
        return { ok: false, error: 'La fecha no puede ser anterior a hoy.' };
    }

    // No permitir fechas absurdamente lejanas (más de 1 año)
    const limite = new Date(hoy);
    limite.setFullYear(limite.getFullYear() + 1);
    if (fecha > limite) {
        return { ok: false, error: 'La fecha no puede ser a más de 1 año vista.' };
    }

    const dd = String(dia).padStart(2, '0');
    const mm = String(mes).padStart(2, '0');
    return { ok: true, valor: `${dd}/${mm}/${anio}` };
}

// Valida e interpreta la cantidad. Acepta formatos español (1.500,50) e inglés (1500.50).
// Devuelve {ok, valor} (número) o {ok:false, error}
function validarCantidad(entrada) {
    let limpio = entrada.trim().replace(/[€\s]/g, '');

    if (!/[\d]/.test(limpio)) {
        return { ok: false, error: 'Escribe solo el número (ejemplo: 1500).' };
    }

    const tieneComa = limpio.includes(',');
    const tienePunto = limpio.includes('.');

    if (tieneComa && tienePunto) {
        // Formato español: el punto es separador de miles, la coma es decimal
        limpio = limpio.replace(/\./g, '').replace(',', '.');
    } else if (tieneComa) {
        // Solo coma → decimal español
        limpio = limpio.replace(',', '.');
    } else if (tienePunto) {
        // Solo punto: ambiguo. Si son grupos de 3 dígitos (1.500 o 1.234.567),
        // se trata como separador de miles. Si no (1500.50), como decimal inglés.
        if (/^\d{1,3}(\.\d{3})+$/.test(limpio)) {
            limpio = limpio.replace(/\./g, '');
        }
        // En cualquier otro caso (ej: 1500.50) se deja como decimal.
    }

    // Tras normalizar solo debe quedar dígitos y como mucho un punto decimal
    if (!/^\d+(\.\d+)?$/.test(limpio)) {
        return { ok: false, error: 'La cantidad tiene un formato extraño. Usa solo números (ejemplo: 1500).' };
    }

    const num = parseFloat(limpio);
    if (isNaN(num) || num <= 0) {
        return { ok: false, error: 'La cantidad debe ser un número mayor que cero.' };
    }
    if (num < CANTIDAD_MIN) {
        return { ok: false, error: `La cantidad mínima es ${CANTIDAD_MIN} €.` };
    }
    if (num > CANTIDAD_MAX) {
        return { ok: false, error: `La cantidad máxima es ${CANTIDAD_MAX.toLocaleString('es-ES')} €.` };
    }

    return { ok: true, valor: num };
}

// ============================================================
//  MODAL
// ============================================================
function construirModal() {
    const modal = new ModalBuilder()
        .setCustomId('form_modal')
        .setTitle('Operación P2P · Cripto');

    const nombre = new TextInputBuilder()
        .setCustomId('nombre')
        .setLabel('Tu nombre completo')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true);

    const usuario = new TextInputBuilder()
        .setCustomId('usuario')
        .setLabel('Tu usuario de Discord')
        .setPlaceholder('Ej: brann0490')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(100)
        .setRequired(true);

    const cantidad = new TextInputBuilder()
        .setCustomId('cantidad')
        .setLabel('Cantidad en dinero (€)')
        .setPlaceholder('Ej: 1500')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(20)
        .setRequired(true);

    const fecha = new TextInputBuilder()
        .setCustomId('fecha')
        .setLabel('Fecha (DD/MM/AAAA)')
        .setPlaceholder('Ej: 25/12/2026')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(10)
        .setRequired(true);

    const mensaje = new TextInputBuilder()
        .setCustomId('mensaje')
        .setLabel('Nota adicional (opcional)')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nombre),
        new ActionRowBuilder().addComponents(usuario),
        new ActionRowBuilder().addComponents(cantidad),
        new ActionRowBuilder().addComponents(fecha),
        new ActionRowBuilder().addComponents(mensaje)
    );

    return modal;
}

// ============================================================
//  MANEJO DE INTERACCIONES
// ============================================================
client.on('interactionCreate', async (interaction) => {
    try {
        // --- Botón fijo: abrir formulario ---
        if (interaction.isButton() && interaction.customId === 'abrir_formulario') {
            const cd = comprobarCooldown(interaction.user.id);
            if (!cd.permitido) {
                await interaction.reply({
                    content: `⏳ Has enviado una solicitud hace poco. Espera **${cd.minutos} min** antes de enviar otra.`,
                    ephemeral: true,
                });
                return;
            }
            await interaction.showModal(construirModal());
            return;
        }

        // --- Respaldo: /formulario ---
        if (interaction.isChatInputCommand() && interaction.commandName === 'formulario') {
            if (interaction.channelId !== process.env.DISCORD_CHANNEL_ID) {
                await interaction.reply({
                    content: `❌ Este comando solo se puede usar en <#${process.env.DISCORD_CHANNEL_ID}>.`,
                    ephemeral: true,
                });
                return;
            }
            const cd = comprobarCooldown(interaction.user.id);
            if (!cd.permitido) {
                await interaction.reply({
                    content: `⏳ Has enviado una solicitud hace poco. Espera **${cd.minutos} min** antes de enviar otra.`,
                    ephemeral: true,
                });
                return;
            }
            await interaction.showModal(construirModal());
            return;
        }

        // --- Envío del modal: validar y mostrar confirmación ---
        if (interaction.isModalSubmit() && interaction.customId === 'form_modal') {
            const nombre = interaction.fields.getTextInputValue('nombre').trim();
            const usuario = interaction.fields.getTextInputValue('usuario').trim();
            const cantidadRaw = interaction.fields.getTextInputValue('cantidad');
            const fechaRaw = interaction.fields.getTextInputValue('fecha');
            const mensaje = interaction.fields.getTextInputValue('mensaje').trim() || '(sin notas)';

            // Validar cantidad
            const cantidadCheck = validarCantidad(cantidadRaw);
            if (!cantidadCheck.ok) {
                await interaction.reply({
                    content: `❌ La **cantidad** no es válida: ${cantidadCheck.error}\n\nVuelve a pulsar el botón e inténtalo de nuevo.`,
                    ephemeral: true,
                });
                return;
            }
            const cantidadNum = cantidadCheck.valor;

            // Validar fecha
            const fechaCheck = validarFecha(fechaRaw);
            if (!fechaCheck.ok) {
                await interaction.reply({
                    content: `❌ La **fecha** no es válida: ${fechaCheck.error}\n\nVuelve a pulsar el botón e inténtalo de nuevo.`,
                    ephemeral: true,
                });
                return;
            }
            const fecha = fechaCheck.valor;

            // Guardar a la espera de confirmación
            pendientesConfirmacion.set(interaction.user.id, {
                nombre,
                usuario,
                cantidad: cantidadNum,
                fecha,
                mensaje,
                discordUsername: interaction.user.username,
                discordId: interaction.user.id,
            });

            const confirmar = new ButtonBuilder()
                .setCustomId('confirmar_envio')
                .setLabel('✅ Confirmar y enviar')
                .setStyle(ButtonStyle.Success);

            const cancelar = new ButtonBuilder()
                .setCustomId('cancelar_envio')
                .setLabel('❌ Cancelar')
                .setStyle(ButtonStyle.Danger);

            await interaction.reply({
                content:
                    '## 📋 Revisa tu solicitud antes de enviar:\n\n' +
                    `📝 **Nombre:** ${nombre}\n` +
                    `💬 **Usuario Discord:** ${usuario}\n` +
                    `💶 **Cantidad:** ${cantidadNum.toLocaleString('es-ES')} €\n` +
                    `📅 **Fecha:** ${fecha}\n` +
                    `🗒️ **Nota:** ${mensaje}\n\n` +
                    '📍 Recuerda: **EN PERSONA, en VALENCIA (España)**. 💵 **Solo damos efectivo.**\n\n' +
                    '¿Es todo correcto?',
                components: [new ActionRowBuilder().addComponents(confirmar, cancelar)],
                ephemeral: true,
            });
            return;
        }

        // --- Cancelar ---
        if (interaction.isButton() && interaction.customId === 'cancelar_envio') {
            pendientesConfirmacion.delete(interaction.user.id);
            await interaction.update({
                content: '❌ Solicitud cancelada. Puedes volver a empezar pulsando el botón del formulario.',
                components: [],
            });
            return;
        }

        // --- Confirmar y enviar a Telegram ---
        if (interaction.isButton() && interaction.customId === 'confirmar_envio') {
            const datos = pendientesConfirmacion.get(interaction.user.id);
            if (!datos) {
                await interaction.update({
                    content: '❌ La sesión expiró. Vuelve a pulsar el botón del formulario.',
                    components: [],
                });
                return;
            }

            const registro = {
                ...datos,
                timestamp: new Date().toISOString(),
            };

            // 1) Guardar SIEMPRE antes de enviar (no perder la operación)
            guardarRegistro(REGISTRO_PATH, registro);

            const texto =
                `📋 *NUEVA OPERACIÓN P2P*\n\n` +
                `👤 *Discord:* ${escaparMarkdown(datos.discordUsername)} \\(ID: ${escaparMarkdown(datos.discordId)}\\)\n` +
                `📝 *Nombre:* ${escaparMarkdown(datos.nombre)}\n` +
                `💬 *Usuario indicado:* ${escaparMarkdown(datos.usuario)}\n` +
                `💶 *Cantidad:* ${escaparMarkdown(datos.cantidad.toLocaleString('es-ES'))} €\n` +
                `📅 *Fecha acordada:* ${escaparMarkdown(datos.fecha)}\n` +
                `📍 *Lugar:* VALENCIA, ESPAÑA \\(en persona\\)\n` +
                `💵 *Modalidad:* SOLO DAMOS EFECTIVO \\(no recibimos efectivo\\)\n` +
                `🗒️ *Nota:* ${escaparMarkdown(datos.mensaje)}`;

            try {
                await enviarTelegram(texto);

                // Marcar cooldown solo tras envío correcto
                cooldowns.set(interaction.user.id, Date.now());
                pendientesConfirmacion.delete(interaction.user.id);

                await interaction.update({
                    content:
                        `✅ **¡Operación registrada y enviada correctamente!**\n\n` +
                        `📝 Nombre: **${datos.nombre}**\n` +
                        `💶 Cantidad: **${datos.cantidad.toLocaleString('es-ES')} €**\n` +
                        `📅 Fecha: **${datos.fecha}**\n\n` +
                        `📍 Recuerda: debes acudir **EN PERSONA a VALENCIA, ESPAÑA**.\n` +
                        `💵 Modalidad: **solo damos efectivo** (no recibimos efectivo).`,
                    components: [],
                });
            } catch (err) {
                console.error('Error enviando a Telegram:', err.message);
                // 2) Registrar el fallo aparte para no perder nada
                guardarRegistro(FALLOS_PATH, { ...registro, error: err.message });

                await interaction.update({
                    content:
                        '⚠️ Tu solicitud **se ha guardado**, pero hubo un problema técnico al notificarla. ' +
                        'No te preocupes: nos pondremos en contacto igualmente. No hace falta que la reenvíes.',
                    components: [],
                });
            }
            return;
        }
    } catch (err) {
        // Red de seguridad: cualquier error inesperado no debe tumbar el bot
        console.error('Error inesperado en interactionCreate:', err);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ Ha ocurrido un error inesperado. Inténtalo de nuevo.',
                ephemeral: true,
            }).catch(() => { });
        }
    }
});

client.once('ready', async () => {
    console.log(`Bot conectado como ${client.user.tag}`);
    await publicarBotonFijo();
});

registerCommands().catch(console.error);
client.login(process.env.DISCORD_TOKEN);