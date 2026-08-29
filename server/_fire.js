// Fires the one-off recovery using the env-injected registration secret.
(async () => {
  const r = await fetch('https://make-it-home-server-production.up.railway.app/admin/recover-egress', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MIH-Registration-Secret': process.env.REGISTRATION_SECRET || '',
    },
    body: JSON.stringify({
      sessionIds: [
        'session_d16c800f84cdefa3b20d72894df96059',
        'session_47ae6cf50341055188fe1d65122f0d8d',
      ],
    }),
  });
  console.log('HTTP', r.status);
  console.log(await r.text());
})();
