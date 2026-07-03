import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import helmet from 'helmet';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, 'session');
const PUBLIC_PATH = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const MAX_RECONNECT_ATTEMPTS = 6;
const SYNC_WARNING_MS = 45_000;
const LOGIN_TIMEOUT_MS = 180_000;

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1kb' }));
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
  })
);
app.use((_, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(
  express.static(PUBLIC_PATH, {
    etag: false,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store');
    },
  })
);

// ── STATE ────────────────────────────────────────────────────────────────
let current = freshState();

function freshState() {
  return {
    sessionId: null,
    status: 'idle',
    code: null,
    sock: null,
    error: null,
    detail: null,
    syncTimer: null,
    hardTimer: null,
    reconnectTimer: null,
    pairingCodeTimer: null,
    reconnectAttempts: 0,
  };
}

function ensureSessionDirectory() {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

function clearTimer(name) {
  if (current[name]) clearTimeout(current[name]);
  current[name] = null;
}

function clearAllTimers() {
  clearTimer('syncTimer');
  clearTimer('hardTimer');
  clearTimer('reconnectTimer');
  clearTimer('pairingCodeTimer');
}

function safeCloseSocket(sock) {
  if (!sock) return;
  try {
    sock.end?.();
  } catch {
    // Ignore socket shutdown errors while resetting state.
  }
}

function clearSession() {
  clearAllTimers();
  safeCloseSocket(current.sock);
  current = freshState();
  fs.rmSync(SESSION_PATH, { recursive: true, force: true });
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

function normalizePhone(input) {
  const raw = String(input || '').trim();

  // Phone number must be E.164 digits without + for Baileys pairing.
  if (!/^\+?[\d\s().-]{10,24}$/.test(raw)) return null;

  const digits = raw.replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(digits)) return null;

  return digits;
}

function readCreds() {
  const credsPath = path.join(SESSION_PATH, 'creds.json');
  if (!fs.existsSync(credsPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  } catch {
    return null;
  }
}

function getSessionHealth() {
  const creds = readCreds();
  const processedHistoryMessages = Array.isArray(creds?.processedHistoryMessages)
    ? creds.processedHistoryMessages.length
    : 0;

  const registered = Boolean(creds?.registered && creds?.me?.id);
  const hasAppState = Boolean(creds?.myAppStateKeyId);

  return {
    hasCreds: Boolean(creds),
    registered,
    hasAppState,
    fullySynced: registered && hasAppState,
    accountSyncCounter: Number.isFinite(creds?.accountSyncCounter) ? creds.accountSyncCounter : null,
    processedHistoryMessages,
    platform: creds?.platform || null,
  };
}

function hasBasicCreds() {
  return getSessionHealth().registered;
}

function hasFullySyncedCreds() {
  return getSessionHealth().fullySynced;
}

function markReady(sessionId) {
  if (current.sessionId !== sessionId) return;
  clearAllTimers();
  current.status = 'ready';
  current.error = null;
  current.detail = 'WhatsApp login finished. creds.json is ready.';
  console.log('✅ Fully synced — creds ready for download');
}

function markSyncPending(sessionId, detail) {
  if (current.sessionId !== sessionId || current.status === 'ready') return;
  current.status = 'connected';
  current.error = null;
  current.detail = detail || 'WhatsApp accepted the code. Finishing login and app-state sync.';
}

function scheduleReconnect(sessionId, reason = 'connection closed') {
  if (current.sessionId !== sessionId || current.status === 'ready') return;
  if (current.reconnectTimer) return;

  if (current.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    current.status = 'error';
    current.error = 'WhatsApp accepted the code, but login did not finish. Tap Start Over, remove the stuck linked device if it appears, and generate a new code.';
    current.detail = reason;
    return;
  }

  current.reconnectAttempts += 1;
  const delayMs = Math.min(12_000, 2_000 * current.reconnectAttempts);
  markSyncPending(sessionId, `WhatsApp accepted the code. Reconnecting to finish login… Attempt ${current.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

  current.reconnectTimer = setTimeout(async () => {
    if (current.sessionId !== sessionId || current.status === 'ready') return;
    current.reconnectTimer = null;

    try {
      await createSocket({ sessionId, requestPairingCode: false });
    } catch (error) {
      console.error('Reconnect failed:', error);
      scheduleReconnect(sessionId, error?.message || 'reconnect failed');
    }
  }, delayMs);
}

function startSlowSyncWarning(sessionId) {
  clearTimer('syncTimer');
  current.syncTimer = setTimeout(() => {
    if (current.sessionId !== sessionId || current.status === 'ready') return;

    const health = getSessionHealth();
    if (health.registered && !health.fullySynced) {
      current.status = 'connected';
      current.error = null;
      current.detail = 'The code was accepted, but WhatsApp is still finishing login. Keep this page open until it says ready.';
      console.log('⏳ Login accepted but app-state sync is still pending');
    }
  }, SYNC_WARNING_MS);
}

function startHardLoginTimeout(sessionId) {
  clearTimer('hardTimer');
  current.hardTimer = setTimeout(() => {
    if (current.sessionId !== sessionId || current.status === 'ready') return;

    const health = getSessionHealth();
    if (health.fullySynced) {
      markReady(sessionId);
      return;
    }

    current.status = 'error';
    current.error = 'WhatsApp stayed on “Logging in” too long. Start over and generate a fresh code.';
    current.detail = health.registered
      ? 'The phone accepted the code, but Baileys did not receive full app-state sync.'
      : 'The phone did not complete registration.';
  }, LOGIN_TIMEOUT_MS);
}

async function createSocket({ sessionId, phone = null, requestPairingCode = false }) {
  if (current.sessionId !== sessionId) throw new Error('Pairing session was reset.');

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();

  safeCloseSocket(current.sock);

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  current.sock = sock;

  let pairingCodeRequested = false;
  let settleCode;
  let rejectCode;
  const codePromise = requestPairingCode
    ? new Promise((resolve, reject) => {
        settleCode = resolve;
        rejectCode = reject;
      })
    : null;

  const requestCodeOnce = async (source) => {
    if (!requestPairingCode || pairingCodeRequested || current.sessionId !== sessionId) return;
    if (state.creds?.registered) return;

    pairingCodeRequested = true;
    clearTimer('pairingCodeTimer');

    try {
      console.log(`📱 Requesting pairing code after ${source}`);
      const code = await sock.requestPairingCode(phone);
      if (current.sessionId !== sessionId) throw new Error('Pairing session was reset.');

      current.code = code;
      current.status = 'pairing';
      current.error = null;
      current.detail = 'Enter this code in WhatsApp > Linked Devices > Link with phone number.';
      console.log('📱 Pairing code generated');
      settleCode?.(code);
    } catch (error) {
      current.status = 'error';
      current.error = error?.message || 'Could not request pairing code. Start over.';
      rejectCode?.(error);
    }
  };

  sock.ev.on('creds.update', async () => {
    if (current.sessionId !== sessionId) return;

    try {
      await saveCreds();

      if (hasFullySyncedCreds()) {
        markReady(sessionId);
        return;
      }

      if (hasBasicCreds()) {
        markSyncPending(sessionId, 'WhatsApp accepted the code. Finishing login and app-state sync…');
      }
    } catch (error) {
      current.status = 'error';
      current.error = 'Could not save session credentials. Start over.';
      current.detail = null;
      console.error('Could not save credentials:', error);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    if (current.sessionId !== sessionId) return;

    const { connection, lastDisconnect, qr } = update;

    if (requestPairingCode && !pairingCodeRequested && (connection === 'connecting' || qr)) {
      await requestCodeOnce(connection === 'connecting' ? 'connecting event' : 'qr event');
    }

    if (connection === 'open') {
      console.log('🔗 Connected — waiting for full sync...');
      current.status = hasFullySyncedCreds() ? 'ready' : 'connected';
      current.error = null;
      current.detail = hasFullySyncedCreds()
        ? 'WhatsApp login finished. creds.json is ready.'
        : 'Connected. Waiting for WhatsApp app-state sync to finish…';

      if (hasFullySyncedCreds()) {
        markReady(sessionId);
      } else {
        startSlowSyncWarning(sessionId);
        startHardLoginTimeout(sessionId);
      }
    }

    if (connection === 'close') {
      if (current.status === 'ready') return;

      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        clearAllTimers();
        current.status = 'error';
        current.error = 'Logged out. Start over and generate a new code.';
        current.detail = null;
        return;
      }

      // Baileys docs say WhatsApp can force a disconnect after pairing; the
      // socket is disposable, so create a fresh socket using saved auth state.
      if (statusCode === DisconnectReason.restartRequired || hasBasicCreds()) {
        scheduleReconnect(sessionId, `connection closed: ${statusCode || 'unknown'}`);
        return;
      }

      current.status = 'error';
      current.error = 'Connection closed before WhatsApp accepted the code. Start over.';
      current.detail = `disconnect code: ${statusCode || 'unknown'}`;
      rejectCode?.(new Error(current.error));
    }
  });

  // Fallback for environments where the first connecting/QR event is missed.
  if (requestPairingCode) {
    current.pairingCodeTimer = setTimeout(() => {
      requestCodeOnce('fallback timer').catch((error) => {
        current.status = 'error';
        current.error = error?.message || 'Could not request pairing code. Start over.';
      });
    }, 2_000);

    return codePromise;
  }

  return null;
}

// ── PAIRING LOGIC ────────────────────────────────────────────────────────
async function startPairing(phone) {
  clearSession();
  ensureSessionDirectory();

  const sessionId = crypto.randomUUID();
  current = {
    ...freshState(),
    sessionId,
    status: 'starting',
    detail: 'Starting WhatsApp pairing session…',
  };

  return createSocket({ sessionId, phone, requestPairingCode: true });
}

ensureSessionDirectory();

// ── ROUTES ───────────────────────────────────────────────────────────────
app.get('/', (_, res) => {
  res.sendFile(path.join(PUBLIC_PATH, 'index.html'));
});

app.get('/healthz', (_, res) => {
  res.status(200).json({ ok: true, status: current.status });
});

app.post('/pair', async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Invalid number. Use country code, for example 919876543210.' });
    }

    const code = await startPairing(phone);
    return res.status(200).json({ code });
  } catch (error) {
    current.status = 'error';
    current.error = error?.message || 'Could not generate pairing code. Start over.';
    current.detail = null;
    console.error('Pairing failed:', error);
    return res.status(500).json({ error: current.error });
  }
});

app.get('/status', (_, res) => {
  res.status(200).json({
    status: current.status,
    error: current.error,
    detail: current.detail,
    code: current.code,
    canDownload: current.status === 'ready' && hasFullySyncedCreds(),
    health: getSessionHealth(),
  });
});

app.get('/download', (_, res) => {
  const credsPath = path.join(SESSION_PATH, 'creds.json');
  if (!fs.existsSync(credsPath)) {
    return res.status(404).json({ error: 'Not ready' });
  }

  if (!hasFullySyncedCreds()) {
    return res.status(409).json({
      error: 'Session is not fully synced yet. Keep the page open until it says ready.',
      health: getSessionHealth(),
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.download(credsPath, 'creds.json');
});

app.post('/reset', (_, res) => {
  try {
    clearSession();
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Reset failed:', error);
    res.status(500).json({ error: 'Could not reset session.' });
  }
});

app.use((_, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((error, _, res, __) => {
  console.error('Unhandled server error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// ── START ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║            Hannan Mariyam            ║');
  console.log('  ║     Made In Love By Afroz Khan  🤍   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log(`  🌐 Open: http://localhost:${PORT}`);
  console.log('');
});
