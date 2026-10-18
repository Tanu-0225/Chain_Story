import { randomUUID } from 'node:crypto';
import { Client } from '@upstash/qstash';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getQueueCollection } from './firebase.js';

const TURN_DURATION_MS = 3 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 60_000;

function getAppBaseUrl() {
  const value = process.env.APP_BASE_URL;
  if (!value) throw new Error('APP_BASE_URL is not configured');

  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_BASE_URL must be an HTTPS origin');
  }
  return url.origin;
}

function getQStashClient() {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('QSTASH_TOKEN is not configured');
  return new Client({ token });
}

function timestampMillis(value) {
  return typeof value?.toMillis === 'function' ? value.toMillis() : 0;
}

async function findActiveQueueItem(queueRef) {
  const snapshot = await queueRef.where('status', '==', 'waiting').get();
  return snapshot.docs
    .sort((left, right) => {
      const timeDifference = timestampMillis(left.get('createdAt')) - timestampMillis(right.get('createdAt'));
      return timeDifference || left.id.localeCompare(right.id);
    })[0];
}

export async function scheduleActiveTurn({ db, appId, queueId, expectedAuthorId }) {
  const queueRef = getQueueCollection(db, appId);
  const now = Date.now();
  const timerToken = randomUUID();
  const claim = await db.runTransaction(async (transaction) => {
    const waitingSnapshot = await transaction.get(queueRef.where('status', '==', 'waiting'));
    const activeItem = waitingSnapshot.docs
      .sort((left, right) => {
        const timeDifference = timestampMillis(left.get('createdAt')) - timestampMillis(right.get('createdAt'));
        return timeDifference || left.id.localeCompare(right.id);
      })[0];
    if (!activeItem || activeItem.id !== queueId) return { reason: 'not_active' };

    const itemRef = queueRef.doc(queueId);
    const itemSnapshot = await transaction.get(itemRef);
    if (!itemSnapshot.exists) return { reason: 'not_found' };

    const item = itemSnapshot.data();
    if (item.status !== 'waiting' || item.authorId !== expectedAuthorId) {
      return { reason: 'not_active' };
    }

    if (item.timerStatus === 'scheduled' && item.timerToken && item.timerExpiresAt) {
      return { reason: 'already_scheduled', expiresAt: item.timerExpiresAt.toMillis() };
    }

    const claimedAt = timestampMillis(item.timerClaimedAt);
    if (item.timerStatus === 'scheduling' && now - claimedAt < CLAIM_LEASE_MS) {
      return { reason: 'in_progress' };
    }

    transaction.update(itemRef, {
      timerStatus: 'scheduling',
      timerToken,
      timerClaimedAt: Timestamp.fromMillis(now)
    });
    return { reason: 'claimed' };
  });

  if (claim.reason !== 'claimed') {
    return {
      scheduled: claim.reason === 'already_scheduled' || claim.reason === 'in_progress',
      reason: claim.reason,
      expiresAt: claim.expiresAt
    };
  }

  try {
    const result = await getQStashClient().publishJSON({
      url: `${getAppBaseUrl()}/api/pass-baton`,
      body: { appId, queueId, timerToken },
      delay: '3h',
      retries: 5
    });

    const expiresAt = Timestamp.fromMillis(Date.now() + TURN_DURATION_MS);
    await db.runTransaction(async (transaction) => {
      const itemRef = queueRef.doc(queueId);
      const itemSnapshot = await transaction.get(itemRef);
      if (
        itemSnapshot.exists &&
        itemSnapshot.get('status') === 'waiting' &&
        itemSnapshot.get('timerToken') === timerToken
      ) {
        transaction.update(itemRef, {
          timerStatus: 'scheduled',
          timerExpiresAt: expiresAt,
          timerMessageId: result.messageId,
          timerScheduledAt: FieldValue.serverTimestamp()
        });
      }
    });

    return { scheduled: true, reason: 'scheduled', expiresAt: expiresAt.toMillis() };
  } catch (error) {
    await db.runTransaction(async (transaction) => {
      const itemRef = queueRef.doc(queueId);
      const itemSnapshot = await transaction.get(itemRef);
      if (itemSnapshot.exists && itemSnapshot.get('timerToken') === timerToken) {
        transaction.update(itemRef, { timerStatus: 'failed' });
      }
    });
    throw error;
  }
}

export async function scheduleCurrentTurn({ db, appId }) {
  const queueRef = getQueueCollection(db, appId);
  const activeItem = await findActiveQueueItem(queueRef);
  if (!activeItem) return { scheduled: false, reason: 'queue_empty' };

  return scheduleActiveTurn({
    db,
    appId,
    queueId: activeItem.id,
    expectedAuthorId: activeItem.get('authorId')
  });
}
