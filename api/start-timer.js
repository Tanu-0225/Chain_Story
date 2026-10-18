import { getAdminServices, isValidAppId } from '../server/firebase.js';
import { scheduleActiveTurn } from '../server/turn-timers.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).send('Method Not Allowed');
  }

  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return response.status(401).json({ error: 'Authentication required' });
  }

  const { appId, queueId } = request.body ?? {};
  if (!isValidAppId(appId) || typeof queueId !== 'string' || !queueId || queueId.length > 1500) {
    return response.status(400).json({ error: 'Invalid timer request' });
  }

  try {
    const { auth, db } = getAdminServices();
    const token = authorization.slice('Bearer '.length);
    const user = await auth.verifyIdToken(token);
    const result = await scheduleActiveTurn({
      db,
      appId,
      queueId,
      expectedAuthorId: user.uid
    });

    if (result.reason === 'not_found') {
      return response.status(404).json({ error: 'Queue entry not found' });
    }
    if (result.reason === 'not_active') {
      return response.status(409).json({ error: 'Queue entry is not the active turn' });
    }

    return response.status(200).json({
      scheduled: result.scheduled,
      reason: result.reason,
      expiresAt: result.expiresAt ?? null
    });
  } catch (error) {
    console.error('Failed to start turn timer:', error);
    return response.status(503).json({ error: 'Unable to schedule the turn timer' });
  }
}
