// pm2-конфиг магазина.  Запуск:  pm2 start deploy/ecosystem.config.js
// Правка окружения → pm2 restart sigma-shop --update-env
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
        GREEN_API_ID: '',
        GREEN_API_TOKEN: '',
        NOTIFY_PHONE: '',
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_PORT: '465',
        SMTP_USER: 'zhakiyeva.mira@gmail.com',
        SMTP_PASS: 'nfruyernfnpvcuat',
        NOTIFY_EMAIL: 'avtomoyki.sales@gmail.com',
        // Вход клиентов по коду: WhatsApp через Green API выше, SMS-резерв — Mobizon
        MOBIZON_API_KEY: '',
      },
    },
  ],
};
