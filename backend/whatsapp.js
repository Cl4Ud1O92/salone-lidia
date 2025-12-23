const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM; // es. "whatsapp:+14155238886"

if (!accountSid || !authToken || !fromNumber) {
  console.warn('⚠️ TWILIO_* environment variables non impostate. WhatsApp disabilitato.');
}

let client = null;
if (accountSid && authToken) {
  client = twilio(accountSid, authToken);
}

async function sendWhatsApp(toNumber, text) {
  if (!client) {
    console.warn('WhatsApp non configurato, messaggio non inviato.');
    return;
  }

  // toNumber deve essere nel formato "whatsapp:+39...."
  if (!toNumber.startsWith('whatsapp:')) {
    throw new Error('toNumber deve iniziare con "whatsapp:".');
  }

  const msg = await client.messages.create({
    from: fromNumber,
    to: toNumber,
    body: text,
  });

  return msg.sid;
}

module.exports = { sendWhatsApp };
