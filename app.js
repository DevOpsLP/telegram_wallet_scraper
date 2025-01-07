const { Telegraf, Scenes, session } = require('telegraf');
const { WizardScene, Stage } = Scenes;
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Ruta del archivo JSON para almacenar las configuraciones
const CONFIG_FILE = path.join(__dirname, 'conditions.json');
// Token del bot
require('dotenv').config();

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// API Key y headers
const API_KEY = process.env.API_KEY;
const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': API_KEY,
};

// Leer configuraciones desde el archivo JSON
function readConditions() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({}), 'utf-8');
  }
  const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(data);
}

// Guardar configuraciones en el archivo JSON
function saveConditions(conditions) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(conditions, null, 2), 'utf-8');
}

// Inicializar las condiciones desde el archivo
let userConditions = readConditions();

// Función para procesar un batch de wallets
async function processBatch(wallets, ctx) {
  try {
    // Hacer la llamada para procesar el batch
    const batchResponse = await axios.post(
      'https://api.dedge.pro/process_wallet_batch',
      { wallet_addresses: wallets },
      { headers }
    );

    const taskId = batchResponse.data.task_id;

    while (true) {
      const statusResponse = await axios.get(`https://api.dedge.pro/batch_status/${taskId}`, { headers });
      const statusData = statusResponse.data;

      if (statusData.status === 'processing') {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        continue;
      }

      if (statusData.status === 'completed') {
        return statusData.results;
      }

      if (statusData.status === 'error') {
        // Si el error es dirección inválida, logueamos y devolvemos un array vacío
        if (statusData.error === 'Invalid wallet address') {
          console.error(`Batch con wallets inválidas: ${wallets.join(', ')}`);
          return [];
        } else if (statusData.error === 'Daily limit exceeded for motus. Maximum 400 requests per day.') {
          await ctx.reply(
            '⚠️ *Límite diario excedido:*\n' +
            'Se ha alcanzado el máximo de 400 solicitudes diarias. Por favor, espera para intentarlo más tarde.',
            { parse_mode: 'Markdown' }
          );
        } else {
          console.error('Error en la API:', statusData.error);
        }
        return [];
      }
    }
  } catch (error) {
    // Manejo de errores inesperados
    if (
      error.response?.data?.detail === 'Daily limit exceeded for motus. Maximum 400 requests per day.'
    ) {
      await ctx.reply(
        '⚠️ *Límite diario excedido:*\n' +
        'Se ha alcanzado el máximo de 400 solicitudes diarias. Por favor, espera para intentarlo más tarde.',
        { parse_mode: 'Markdown' }
      );
    } else if (error.response?.data?.detail === 'Invalid wallet address') {
      console.error(`Batch con wallets inválidas: ${wallets.join(', ')}`);
      // Simplemente retornamos un array vacío y seguimos con el resto
      return [];
    } else {
      console.error('Error al procesar el batch:', error.response?.data || error.message);
      await ctx.reply(
        '❌ *Error al procesar el batch:*\n' +
        `${error.message || 'Ocurrió un error inesperado.'}`,
        { parse_mode: 'Markdown' }
      );
    }
    return [];
  }
}

// Escena de Wizard para `/scrape`
const scrapeScene = new WizardScene(
  'scrape-scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const config = userConditions[userId];

    // Verify if the user has configured conditions
    if (!config) {
      await ctx.reply('Para usar este comando, primero configura tus condiciones con /configurar.');
      return ctx.scene.leave();
    }

    await ctx.reply('Por favor, envía la lista de wallets (una por línea).');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const config = userConditions[userId];
    const wallets = ctx.message.text
    .split('\n')
    .map((wallet) => wallet.trim())
    .filter((wallet) => wallet !== '');
    const batchSize = 5;

    // Split wallets into batches of size 5
    const batches = [];
    for (let i = 0; i < wallets.length; i += batchSize) {
      batches.push(wallets.slice(i, i + batchSize));
    }

    // console.log(`Created ${batches.length} batches for processing.`);

    // Notify the user about the processing time
    await ctx.reply('Recibimos las wallets. Por favor espera, esto puede tomar unos minutos mientras procesamos los datos.');

    // Exit the scene immediately
    ctx.scene.leave();

    // Process batches asynchronously
    setImmediate(async () => {
      const results = [];
      const totalBatches = batches.length;

      for (let i = 0; i < totalBatches; i++) {
      const batch = batches[i];
      // console.log(`Processing batch: ${JSON.stringify(batch)}`);
      
      const batchResults = await processBatch(batch, ctx);
            
      if (!batchResults || batchResults.length === 0) {
        // console.log(`No results returned for batch: ${JSON.stringify(batch)}`);
        continue;
      }
      
      // Filter valid results based on user conditions
      const validResults = batchResults.filter((result) => {
        if (
        !result.summary ||
        !result.summary.general_performance ||
        !result.summary.general_performance.last_trade_timestamp ||
        !result.summary.deltas
        ) {
        return false;
        }
      
        const {
        summary: { general_performance, closed_trades_overview, deltas }
        } = result;
      
        const { last_trade_timestamp } = general_performance;
        const { overall_mean_delta } = deltas;
      
        const lastTradeDate = new Date(last_trade_timestamp);
        const daysAgo = (new Date() - lastTradeDate) / (1000 * 60 * 60 * 24); // Convert to days
      
        const isValid =
        daysAgo <= config.lastTradeDays &&
        closed_trades_overview.win_rate_percent >= config.winRate &&
        general_performance.net_sol >= config.netPL &&
        overall_mean_delta / 60 >= config.avgTradingTime; // Convert seconds to minutes
      
        // console.log(
        // `Wallet: ${result.wallet_address}, Valid: ${isValid}, DaysAgo: ${daysAgo}, WinRate: ${closed_trades_overview.win_rate_percent}, NetPL: ${general_performance.net_sol}, AvgTradingTime: ${overall_mean_delta / 60}`
        // );
      
        return isValid;
      });
      
      results.push(...validResults);

      // Send progress update every 2-3 batches
      if ((i + 1) % 2 === 0 || i === totalBatches - 1) {
        const progress = Math.round(((i + 1) / totalBatches) * 100);
        await ctx.reply(`🔄 Procesando... ${progress}% completado.`);
      }
      }
      
      // Send results to the user
      if (results.length === 0) {
      await ctx.reply('❌ *No se encontraron wallets que cumplan con tus condiciones.*', { parse_mode: 'Markdown' });
      } else {
      const responseText = results
        .map((result) =>
        `💼 *Wallet:* \`${result.wallet_address}\`\n` +
        `📊 *Tokens Tradeados:* ${result.summary.general_performance.tokens_traded}\n` +
        `💰 *Ganancia Neta (SOL):* ${result.summary.general_performance.net_sol.toFixed(2)}\n` +
        `🏆 *Win Rate:* ${result.summary.closed_trades_overview.win_rate_percent}%\n` +
        `⏱️ *Avg Trading Time:* ${(result.summary.deltas.overall_mean_delta / 60).toFixed(2)} minutos\n` +
        `📅 *Último Trade:* ${result.summary.general_performance.last_trade_timestamp}`
        )
        .join('\n\n');
      
      // console.log('Final valid results:', results); // Log final valid results for debugging
      await ctx.reply(`✅ *Resultados procesados:*\n\n${responseText}`, { parse_mode: 'Markdown' });
      }
      
    });

  }
);

// Escena de configuración (sin cambios)
const configScene = new WizardScene(
  'config-scene',
  (ctx) => {
    ctx.reply('Vamos a configurar tus condiciones.\nPrimero, ¿Cuál será el tiempo promedio de trading mínimo en minutos (X)?');
    return ctx.wizard.next();
  },
  (ctx) => {
    const avgTradingTime = parseFloat(ctx.message.text);
    if (isNaN(avgTradingTime) || avgTradingTime < 0) {
      ctx.reply('Por favor, introduce un número válido para el tiempo promedio de trading en minutos.');
      return;
    }
    ctx.scene.state.avgTradingTime = avgTradingTime;
    ctx.reply('¿Cuál será la ganancia neta mínima (Net PL) en SOL?');
    return ctx.wizard.next();
  },
  (ctx) => {
    const netPL = parseFloat(ctx.message.text);
    if (isNaN(netPL)) {
      ctx.reply('Por favor, introduce un número válido para la ganancia neta mínima.');
      return;
    }
    ctx.scene.state.netPL = netPL;
    ctx.reply('¿Cuál será el balance actual mínimo en SOL?');
    return ctx.wizard.next();
  },
  (ctx) => {
    const balanceActual = parseFloat(ctx.message.text);
    if (isNaN(balanceActual)) {
      ctx.reply('Por favor, introduce un número válido para el balance actual mínimo.');
      return;
    }
    ctx.scene.state.balanceActual = balanceActual;
    ctx.reply('¿Cuál será el porcentaje de Win Rate mínimo (X%)?');
    return ctx.wizard.next();
  },
  (ctx) => {
    const winRate = parseFloat(ctx.message.text);
    if (isNaN(winRate) || winRate < 0 || winRate > 100) {
      ctx.reply('Por favor, introduce un porcentaje válido entre 0 y 100.');
      return;
    }
    ctx.scene.state.winRate = winRate;
    ctx.reply('¿Cuántos días atrás debe estar el último trade como máximo?');
    return ctx.wizard.next();
  },
  (ctx) => {
    const lastTradeDays = parseInt(ctx.message.text);
    if (isNaN(lastTradeDays) || lastTradeDays < 0) {
      ctx.reply('Por favor, introduce un número válido para los días.');
      return;
    }
    ctx.scene.state.lastTradeDays = lastTradeDays;

    const userId = ctx.from.id.toString();
    userConditions[userId] = {
      avgTradingTime: ctx.scene.state.avgTradingTime,
      netPL: ctx.scene.state.netPL,
      balanceActual: ctx.scene.state.balanceActual,
      winRate: ctx.scene.state.winRate,
      lastTradeDays: ctx.scene.state.lastTradeDays,
    };
    saveConditions(userConditions);

    ctx.reply(`¡Condiciones configuradas!\n\nTiempo promedio de trading: ${ctx.scene.state.avgTradingTime} minutos\nGanancia neta mínima: ${ctx.scene.state.netPL} SOL\nBalance actual mínimo: ${ctx.scene.state.balanceActual} SOL\nWin Rate mínimo: ${ctx.scene.state.winRate}%\nÚltimo trade máximo: ${ctx.scene.state.lastTradeDays} días`);
    return ctx.scene.leave();
  }
);

// Registrar escenas y middleware
const stage = new Stage([scrapeScene, configScene]);
bot.use(session());
bot.use(stage.middleware());

// Comandos
bot.telegram.setMyCommands([
  { command: 'scrape', description: 'Procesar wallets' },
  { command: 'configurar', description: 'Configurar condiciones' },
  { command: 'ver_configuracion', description: 'Ver condiciones actuales' },
]);

bot.command('scrape', (ctx) => ctx.scene.enter('scrape-scene'));
bot.command('configurar', (ctx) => ctx.scene.enter('config-scene'));
bot.command('ver_configuracion', (ctx) => {
  const userId = ctx.from.id.toString();
  const config = userConditions[userId];
  if (!config) {
    ctx.reply('No tienes condiciones configuradas. Usa /configurar para empezar.');
  } else {
    ctx.reply(`Tu configuración actual:\n\nTiempo promedio de trading: ${config.avgTradingTime} minutos\nGanancia neta mínima: ${config.netPL} SOL\nBalance actual mínimo: ${config.balanceActual} SOL\nWin Rate mínimo: ${config.winRate}%\nÚltimo trade máximo: ${config.lastTradeDays} días`);
  }
});

// Manejar errores
bot.catch((err, ctx) => console.error(`Error en ${ctx.updateType}:`, err));

// Iniciar bot
bot.launch().then(() => console.log('El bot está funcionando.'));
process.once('SIGINT', () => bot.stop('SIGINT')); 
process.once('SIGTERM', () => bot.stop('SIGTERM'));
