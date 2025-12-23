const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// Carica le "credenziali" dalle variabili d'ambiente
function loadCredentials() {
  const client_id = process.env.GOOGLE_CLIENT_ID;
  const client_secret = process.env.GOOGLE_CLIENT_SECRET;

  if (!client_id || !client_secret) {
    throw new Error('GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET mancanti nelle Environment Variables');
  }

  // Simula la struttura di credentials.json
  return {
    installed: {
      client_id,
      client_secret,
      redirect_uris: ['urn:ietf:wg:oauth:2.0:oob', 'http://localhost']
    }
  };
}

// Carica il "token" dalle variabili d'ambiente
function loadToken() {
  const refresh_token = process.env.GOOGLE_REFRESH_TOKEN;

  if (!refresh_token) {
    throw new Error('GOOGLE_REFRESH_TOKEN mancante nelle Environment Variables');
  }

  return {
    access_token: '',
    refresh_token,
    scope: SCOPES.join(' '),
    token_type: 'Bearer',
    expiry_date: 0
  };
}

// Crea il client OAuth2 pronto all'uso
function authorize() {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const token = loadToken();
  oAuth2Client.setCredentials(token);

  return oAuth2Client;
}

// (opzionale) manteniamo saveTokenFromCode se ti serve in locale, ma NON usa più file su Render
async function saveTokenFromCode(code, res) {
  try {
    const credentials = loadCredentials();
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    const { tokens } = await oAuth2Client.getToken(code);
    // In produzione su Render NON salviamo su file.
    // Puoi loggare il refresh_token e copiarlo a mano in Render.
    console.log('Nuovo refresh_token:', tokens.refresh_token);
    res.send('Token generato. Copia il refresh_token nei settings di Render.');
  } catch (err) {
    console.error('Errore recupero token:', err);
    res.status(400).send('Errore recupero token: ' + err.message);
  }
}

// Crea evento in Google Calendar
function createEvent(eventData) {
  return new Promise((resolve, reject) => {
    try {
      const auth = authorize();
      const calendar = google.calendar({ version: 'v3', auth });

      calendar.events.insert(
        {
          calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
          resource: eventData
        },
        (err, event) => {
          if (err) return reject(err);
          resolve(event.data);
        }
      );
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { saveTokenFromCode, createEvent };
