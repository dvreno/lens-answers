// Speech-to-text client: local audio.cpp server first, optional (off by default) cloud backup.
// The WAV is built in memory; no audio touches the disk.

const LOCAL_TIMEOUT_MS = 10_000;
const BACKUP_TIMEOUT_MS = 20_000;

// Wrap 16-bit little-endian mono PCM in a WAV header.
export function pcmToWav(pcm, sampleRate = 16000) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function post({ baseUrl, model, wav, apiKey, timeoutMs, fetchImpl }) {
  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`, {
    method: 'POST',
    ...(headers ? { headers } : {}),
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`ASR ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  return String(data?.text ?? '').trim();
}

/**
 * @param {{asr:{url:string, model:string, backup:{enabled:boolean,url:string,model:string,keyEnv:string}}}} config
 * @param {{fetchImpl?: typeof fetch, env?: Record<string,string|undefined>}} [deps]
 */
export function createAsr(config, { fetchImpl = fetch, env = process.env } = {}) {
  const { asr } = config;

  async function transcribe(pcm) {
    const wav = pcmToWav(pcm);
    try {
      const text = await post({ baseUrl: asr.url, model: asr.model, wav, timeoutMs: LOCAL_TIMEOUT_MS, fetchImpl });
      return { text, via: 'local' };
    } catch (localError) {
      // Audio leaves this machine only when the backup has been switched on.
      if (!asr.backup?.enabled) throw localError;
      const apiKey = env[asr.backup.keyEnv];
      if (!apiKey) throw new Error(`ASR backup enabled but ${asr.backup.keyEnv} is not set (local: ${localError.message})`);
      if (!asr.backup.url) throw new Error(`ASR backup enabled but no backup url (local: ${localError.message})`);
      const text = await post({
        baseUrl: asr.backup.url,
        model: asr.backup.model || asr.model,
        wav,
        apiKey,
        timeoutMs: BACKUP_TIMEOUT_MS,
        fetchImpl,
      });
      return { text, via: 'backup' };
    }
  }

  return { transcribe };
}
