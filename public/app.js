const pairForm = document.getElementById('pairForm');
const phoneInput = document.getElementById('phone');
const generateBtn = document.getElementById('generateBtn');
const formError = document.getElementById('formError');
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const codeText = document.getElementById('codeText');
const statusBox = document.getElementById('statusBox');
const downloadBtn = document.getElementById('downloadBtn');
const resetBtn = document.getElementById('resetBtn');

let poll = null;

function normalizePhone(value) {
  const raw = String(value || '').trim();
  const allowedFormat = /^\+?[\d\s().-]{10,24}$/.test(raw);
  if (!allowedFormat) return null;

  const digits = raw.replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(digits)) return null;

  return digits;
}

async function readJsonResponse(response) {
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(data.error || 'Request failed. Try again.');
  }

  return data;
}

function setFormError(message = '') {
  formError.textContent = message;
}

function setStatus(type, message, spinning = false) {
  statusBox.className = `status ${type}`;
  statusBox.textContent = '';

  if (spinning) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    spinner.textContent = type === 'connected' ? '🔄' : '⏳';
    statusBox.appendChild(spinner);
  }

  const text = document.createElement('span');
  text.textContent = message;
  statusBox.appendChild(text);
}

function stopPolling() {
  if (poll) clearInterval(poll);
  poll = null;
}

function showCodeScreen(code) {
  codeText.textContent = code;
  step1.hidden = true;
  step2.hidden = false;
  downloadBtn.hidden = true;
  setStatus('waiting', 'Waiting for you to enter the code…', true);
}

async function startPairing(event) {
  event.preventDefault();
  stopPolling();
  setFormError();

  const phone = normalizePhone(phoneInput.value);
  if (!phone) {
    setFormError('Enter a valid number with country code, for example 919876543210.');
    phoneInput.focus();
    return;
  }

  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating…';

  try {
    const response = await fetch('/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await readJsonResponse(response);

    if (!data.code) throw new Error(data.error || 'Could not generate pairing code.');

    showCodeScreen(data.code);
    startPolling();
  } catch (error) {
    setFormError(error.message || 'Something went wrong. Try again.');
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate Pairing Code';
  }
}

function startPolling() {
  stopPolling();

  poll = setInterval(async () => {
    try {
      const response = await fetch('/status', { cache: 'no-store' });
      const { status, error } = await readJsonResponse(response);

      if (status === 'starting') {
        setStatus('waiting', 'Starting secure pairing session…', true);
        return;
      }

      if (status === 'pairing') {
        setStatus('waiting', 'Waiting for you to enter the code…', true);
        return;
      }

      if (status === 'connected') {
        setStatus('connected', 'Connected! Saving session files…', true);
        return;
      }

      if (status === 'ready') {
        setStatus('ready', 'Session is ready. Download the ZIP now.');
        downloadBtn.hidden = false;
        stopPolling();
        return;
      }

      if (status === 'error') {
        setStatus('error', error || 'Something went wrong. Start over.');
        downloadBtn.hidden = true;
        stopPolling();
      }
    } catch {
      setStatus('error', 'Connection lost. Refresh and try again.');
      downloadBtn.hidden = true;
      stopPolling();
    }
  }, 2000);
}

function downloadSession() {
  window.location.assign('/download');
}

async function resetSession() {
  stopPolling();
  resetBtn.disabled = true;
  resetBtn.textContent = 'Resetting…';

  try {
    await fetch('/reset', { method: 'POST' });
  } finally {
    window.location.reload();
  }
}

pairForm.addEventListener('submit', startPairing);
downloadBtn.addEventListener('click', downloadSession);
resetBtn.addEventListener('click', resetSession);

phoneInput.addEventListener('input', () => {
  if (formError.textContent) setFormError();
});
