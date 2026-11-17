// pm2-конфиг магазина.  Запуск:  pm2 start deploy/ecosystem.config.js
// Правка окружения → pm2 restart deploy/ecosystem.config.js --update-env
module.exports = {
  apps: [
    {
      name: 'sigma-shop',
      script: 'server.js',
      cwd: '/home/ubuntu/sigma-shop',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '350M',
      // Время перед каждой строкой лога (pm2 logs) — без этого не видно, когда
      // именно что-то произошло, только порядок строк.
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        SITE_URL: 'https://b2btech.kz',
        SITE_NOINDEX: '0',
        YM_ID: 112428503,
        // Вебвизор (запись сеансов посетителей в Яндекс.Метрике) — отключён: замедлял
        // отклик сайта на нажатия (INP) у всех посетителей. Включить — поставить '1'.
        YM_WEBVISOR: '0',
        GADS_ID: 'AW-18370364758',
        // Уведомления о заказах (WhatsApp + почта)
        // WhatsApp через официальный Meta Business API (developers.facebook.com →
        // приложение → WhatsApp → API Setup): Access Token и Phone Number ID оттуда.
        META_WA_TOKEN: 'EABFoPVlwpzMBSZBipKM3IlSMSbZBadqfaCjRwdn77crQ7szIuunkzU5d5fE66priFeAZA618iqGCZBFrsbRutx62cvwbAiC5tYZCBCbUJVh83C5TvcjZBJZCSHT5beeizYmyl8qe6ISZBeZBjPYFWvoyD2VaTri4dbYlf2jfugJp9ZCbNT7AS2hFIT65cld9hYkteYegZDZD',
        META_WA_PHONE_ID: '1329717896896472',
        // Свой секрет для поля "Подтверждение маркера" (Verify Token) в настройке
        // Webhooks там же в кабинете — любая строка, придумана нами, никуда не
        // отправляется заранее, просто должна совпадать в обоих местах.
        META_WA_VERIFY_TOKEN: '97f147ca30547b002911b3fba9b7756bd10162f4e79e98e7',
        NOTIFY_PHONE: '787074202003',
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_PORT: '465',
        SMTP_USER: 'avtomoyki.sales@gmail.com',
        SMTP_PASS: 'fqveoxqsxbqwgfot',
        NOTIFY_EMAIL: 'avtomoyki.sales@gmail.com',
        // Больше не используется — вход по коду на телефон (WhatsApp/SMS) заменён на
        // email+пароль и Telegram (см. auth.js). Оставлено на случай, если Mobizon
        // понадобится для чего-то ещё; можно удалить.
        MOBIZON_API_KEY: 'kz8ba5fe3d4bba16b328df79dbe4aa82791d6429d23f8c548f2c08e83d2360c51382ae',
        // Вход через Telegram (см. auth.js, settings.telegram в админке) — токен от
        // @BotFather после создания бота. Username бота — отдельно, в настройках
        // админки (Вовлечённость → Вход клиентов), он публичный, не секрет.
        TELEGRAM_BOT_TOKEN: '9012778025:AAE78OyV4T5yxMqEQq58uPpKDQATwwQ3WLg',
      },
    },
  ],
};
