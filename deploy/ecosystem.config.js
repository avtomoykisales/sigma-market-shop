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
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        SITE_URL: 'https://b2btech.kz',
        SITE_NOINDEX: '0',
        YM_ID: 112428503,
        // Уведомления о заказах (WhatsApp + почта)
        // WhatsApp через официальный Meta Business API (developers.facebook.com →
        // приложение → WhatsApp → API Setup): Access Token и Phone Number ID оттуда.
        META_WA_TOKEN: '',
        META_WA_PHONE_ID: '',
        NOTIFY_PHONE: '',
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_PORT: '465',
        SMTP_USER: 'zhakiyeva.mira@gmail.com',
        SMTP_PASS: 'nfruyernfnpvcuat',
        NOTIFY_EMAIL: 'avtomoyki.sales@gmail.com',
        // Вход клиентов по коду: SMS-резерв — Mobizon
        MOBIZON_API_KEY: 'kz8ba5fe3d4bba16b328df79dbe4aa82791d6429d23f8c548f2c08e83d2360c51382ae',
      },
    },
  ],
};
