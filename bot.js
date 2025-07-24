require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const config = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  CHANNEL_ID: process.env.TELEGRAM_CHANNEL_ID,
  GITHUB_USER: process.env.GITHUB_USERNAME,
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL_MINUTES || '3') * 60 * 1000,
  DB_FILE: path.join(__dirname, process.env.DATABASE_FILE || 'repos.db')
};


if (!config.TELEGRAM_TOKEN || !config.CHANNEL_ID || !config.GITHUB_USER) {
  throw new Error('Необходимо указать все обязательные переменные в .env файле');
}

const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: false });
const db = new sqlite3.Database(config.DB_FILE);


db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS published_repos (
    id INTEGER PRIMARY KEY,
    name TEXT,
    created_at TEXT
  )`);
});

async function checkRepos() {
  try {
    console.log(`[${new Date().toISOString()}] Проверка репозиториев...`);
    
    const response = await axios.get(
      `https://api.github.com/users/${config.GITHUB_USER}/repos?sort=created&direction=desc`, 
      {
        headers: { 'User-Agent': 'GitHub-Repos-Checker' }
      }
    );

    const repos = response.data.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    for (const repo of repos) {
      if (!repo.description || repo.description.trim() === '') {
        continue;
      }

      const exists = await new Promise((resolve) => {
        db.get('SELECT 1 FROM published_repos WHERE id = ?', [repo.id], (err, row) => {
          resolve(!!row);
        });
      });

      if (!exists) {
        try {
          await sendTelegramMessage(repo);
          db.run('INSERT INTO published_repos (id, name, created_at) VALUES (?, ?, ?)', 
            [repo.id, repo.name, repo.created_at]);
          
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (err) {
          console.error(`Ошибка при публикации ${repo.name}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('Ошибка при проверке репозиториев:', err.message);
  }
}

async function sendTelegramMessage(repo) {
  const message = `
📌 <b>Новый репозиторий</b>  

<b>${repo.name}</b> 

<b>Описание:</b>  
${repo.description}  

<b>🔗 Ссылки:</b>  
├ Код: <a href="${repo.html_url}">GitHub</a>  
${repo.homepage ? `└ Демо: <a href="${repo.homepage}">Live</a>` : ''}  

#${repo.language || 'Code'} #${repo.name.replace(/[-_]/g, '')}  
`.trim();

  try {
    await bot.sendMessage(config.CHANNEL_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });
  } catch (err) {
    if (err.response?.statusCode === 429) {
      const retryAfter = err.response.parameters?.retry_after || 10;
      console.log(`Лимит Telegram. Пауза ${retryAfter} сек...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return sendTelegramMessage(repo);
    }
    throw err;
  }
}

setInterval(checkRepos, config.CHECK_INTERVAL);
checkRepos();

process.on('SIGINT', () => {
  db.close();
  process.exit();
});