import { Receiver } from '@upstash/qstash';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminServices, getQueueCollection, isValidAppId } from '../server/firebase.js';
import { scheduleCurrentTurn } from '../server/turn-timers.js';

export const config = {
  api: { bodyParser: false }
};

const MAX_BODY_BYTES = 16 * 1024;

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function getReceiver() {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    throw new Error('QStash signing keys are not configured');
  }
  return new Receiver({ currentSigningKey, nextSigningKey });
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).send('Method Not Allowed');
  }

  try {
    const rawBody = await readRawBody(request);
    const signature = request.headers['upstash-signature'];
    const appBaseUrl = process.env.APP_BASE_URL;
    if (!appBaseUrl || typeof signature !== 'string') {
      return response.status(401).json({ error: 'Invalid QStash callback' });
    }

    const isValid = await getReceiver().verify({
      signature,
      body: rawBody,
      url: `${new URL(appBaseUrl).origin}/api/pass-baton`
    });
    if (!isValid) {
      return response.status(401).json({ error: 'Invalid QStash signature' });
    }

    const payload = JSON.parse(rawBody);
    const { appId, queueId, timerToken } = payload;
    if (
      !isValidAppId(appId) ||
      typeof queueId !== 'string' ||
      !queueId ||
      typeof timerToken !== 'string' ||
      !timerToken
    ) {
      return response.status(400).json({ error: 'Invalid timer callback' });
    }

    const { db } = getAdminServices();
    const queueRef = getQueueCollection(db, appId);
    const itemRef = queueRef.doc(queueId);
    const callbackState = await db.runTransaction(async (transaction) => {
      const itemSnapshot = await transaction.get(itemRef);
      if (
        !itemSnapshot.exists ||
        itemSnapshot.get('status') !== 'waiting' ||
        itemSnapshot.get('timerStatus') !== 'scheduled' ||
        itemSnapshot.get('timerToken') !== timerToken
      ) {
        return 'stale';
      }

      const expiresAt = itemSnapshot.get('timerExpiresAt');
      if (!expiresAt || expiresAt.toMillis() > Date.now()) {
        return 'early';
      }

      transaction.update(itemRef, {
        status: 'timed_out',
        timerStatus: 'expired',
        timedOutAt: FieldValue.serverTimestamp(),
        timerExpiredAt: Timestamp.now()
      });
      return 'expired';
    });

    if (callbackState === 'early') {
      return response.status(503).json({ error: 'Timer callback arrived before the deadline' });
    }

    await scheduleCurrentTurn({ db, appId });
    return response.status(200).json({ success: true, state: callbackState });
  } catch (error) {
    console.error('Failed to process QStash timer callback:', error);
    return response.status(503).json({ error: 'Unable to process timer callback' });
  }
}
