import { connect } from 'node:net';

/**
 * Malware scanning for mod downloads.
 *
 * Read the states carefully, because the difference between them is the whole
 * point. "clean" means every engine that looked found nothing -- not that the
 * file is safe. "unknown" means nobody has ever seen this file, which for a
 * brand-new mod release is the normal answer and for an old popular mod is
 * itself worth a second look. Neither is a guarantee, and nothing in this
 * module should be presented as one: a mod is code that runs inside the game
 * server, and no scanner can decide whether code is hostile.
 *
 * What these do provide is the multi-engine opinion an operator would
 * otherwise have to go and get by hand, attached to the exact bytes that are
 * about to be installed.
 */

export type ScanState = 'clean' | 'malicious' | 'suspicious' | 'unknown' | 'error' | 'off';

export interface ScanVerdict {
  scanner: string;
  label: string;
  state: ScanState;
  summary: string;
  detail?: string;
}

export interface ScannerConfig {
  virustotalApiKey?: string;
  clamavHost?: string;
  clamavPort?: number;
}

/* ---- VirusTotal ---------------------------------------------------------
   Looked up by hash only. The file is never uploaded: the portal has no
   business shipping someone's mod to a third party, and a hash lookup answers
   the question without it.                                                  */

interface VtResponse {
  data?: {
    attributes?: {
      last_analysis_stats?: Record<string, number>;
      last_analysis_date?: number;
      meaningful_name?: string;
    };
  };
}

async function virustotal(sha256: string, apiKey: string): Promise<ScanVerdict> {
  const base = { scanner: 'virustotal', label: 'VirusTotal' };
  let response: Response;
  try {
    response = await fetch(`https://www.virustotal.com/api/v3/files/${sha256}`, {
      headers: { 'x-apikey': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ...base, state: 'error', summary: 'Could not be reached.', detail: (err as Error).message };
  }

  if (response.status === 404) {
    return {
      ...base,
      state: 'unknown',
      summary: 'Never seen this file before.',
      detail:
        'Normal for a mod released in the last day or two. For an established mod it is worth asking why the bytes are new.',
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ...base, state: 'error', summary: 'The API key was refused.' };
  }
  if (response.status === 429) {
    return { ...base, state: 'error', summary: 'Rate limit reached; try again shortly.' };
  }
  if (!response.ok) {
    return { ...base, state: 'error', summary: `Answered ${response.status}.` };
  }

  const body = (await response.json()) as VtResponse;
  const stats = body.data?.attributes?.last_analysis_stats ?? {};
  const malicious = stats.malicious ?? 0;
  const suspicious = stats.suspicious ?? 0;
  const engines = Object.values(stats).reduce((a, b) => a + b, 0);
  const when = body.data?.attributes?.last_analysis_date;
  const detail = when ? `Last analysed ${new Date(when * 1000).toISOString().slice(0, 10)}.` : undefined;

  if (malicious > 0) {
    return {
      ...base,
      state: 'malicious',
      summary: `${malicious} of ${engines} engines call this malicious.`,
      detail,
    };
  }
  if (suspicious > 0) {
    return {
      ...base,
      state: 'suspicious',
      summary: `${suspicious} of ${engines} engines call this suspicious.`,
      detail,
    };
  }
  return { ...base, state: 'clean', summary: `No detections from ${engines} engines.`, detail };
}

/* ---- ClamAV -------------------------------------------------------------
   Streamed to a clamd instance over TCP using INSTREAM, so nothing is written
   to disk to be scanned and nothing leaves the network.                     */

function clamav(body: Buffer, host: string, port: number): Promise<ScanVerdict> {
  const base = { scanner: 'clamav', label: 'ClamAV' };

  return new Promise<ScanVerdict>((resolve) => {
    const socket = connect({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (verdict: ScanVerdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };

    socket.setTimeout(30_000, () =>
      finish({ ...base, state: 'error', summary: 'Timed out talking to clamd.' }),
    );
    socket.on('error', (err) =>
      finish({ ...base, state: 'error', summary: 'Could not reach clamd.', detail: err.message }),
    );

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      // Length-prefixed chunks, then a zero length to mark the end.
      for (let at = 0; at < body.length; at += 65536) {
        const slice = body.subarray(at, at + 65536);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(slice.length);
        socket.write(header);
        socket.write(slice);
      }
      socket.write(Buffer.from([0, 0, 0, 0]));
    });

    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim();
      if (reply.endsWith('OK')) {
        return finish({ ...base, state: 'clean', summary: 'No signature matched.' });
      }
      if (reply.includes('FOUND')) {
        return finish({
          ...base,
          state: 'malicious',
          summary: reply.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, ''),
          detail: 'clamd matched a known signature.',
        });
      }
      finish({ ...base, state: 'error', summary: reply || 'clamd gave no answer.' });
    });
  });
}

/**
 * Runs whichever scanners are configured. With none configured this returns a
 * single 'off' verdict rather than an empty list, so the report can never be
 * mistaken for "scanned and found nothing".
 */
export async function runScanners(
  body: Buffer,
  sha256: string,
  config: ScannerConfig,
): Promise<ScanVerdict[]> {
  const jobs: Array<Promise<ScanVerdict>> = [];

  if (config.virustotalApiKey) jobs.push(virustotal(sha256, config.virustotalApiKey));
  if (config.clamavHost) jobs.push(clamav(body, config.clamavHost, config.clamavPort ?? 3310));

  if (jobs.length === 0) {
    return [
      {
        scanner: 'none',
        label: 'Malware scanning',
        state: 'off',
        summary: 'No scanner is configured.',
        detail:
          'Add a VirusTotal API key or a ClamAV address in Settings. Without one, nothing checks these bytes against known malware.',
      },
    ];
  }
  return Promise.all(jobs);
}

/** The worst verdict present, which is what gates an install. */
export function worstState(verdicts: ScanVerdict[]): ScanState {
  const order: ScanState[] = ['malicious', 'suspicious', 'error', 'unknown', 'off', 'clean'];
  for (const state of order) {
    if (verdicts.some((v) => v.state === state)) return state;
  }
  return 'clean';
}
